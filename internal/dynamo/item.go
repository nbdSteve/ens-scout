package dynamo

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/snapshot"
)

// Item attribute names. The table is a single-table design keyed by attrPartition
// and attrSort, whose values come from snapshot.SnapshotPartition,
// snapshot.ChunkSort, snapshot.LatestPartition, and snapshot.LatestSort, so the key
// layout lives in the contract and not here.
const (
	attrPartition = "pk"
	attrSort      = "sk"

	// attrFormatVersion carries snapshot.FormatVersion on every item this package
	// writes. The item layout is part of the same wire contract as the payload, so
	// it shares one version number rather than introducing a second, and a reader
	// rejects a version it does not know instead of guessing at the attributes.
	attrFormatVersion = "format_version"

	// attrSnapshotID repeats the snapshot ID that attrPartition encodes. A chunk
	// checksum covers only its payload bytes, so the envelope is unauthenticated
	// and chunk identity has to be anchored on an independently supplied ID; a
	// reader compares this against the ID it asked for.
	attrSnapshotID = "snapshot_id"

	attrChunkIndex = "chunk_index"
	attrChunkCount = "chunk_count"
	attrChecksum   = "checksum"
	attrPayload    = "payload"

	// attrExpiresAt is the table's TTL attribute, in Unix seconds. It is absent
	// while a snapshot is current and is set only once the snapshot is superseded.
	attrExpiresAt = "expires_at"

	// attrStagedAt is when a publisher last claimed a snapshot ID, on a staging
	// marker. It is stored as RFC3339 rather than as a Unix second so an operator
	// reading the table can tell it apart from attrExpiresAt at a glance.
	attrStagedAt = "staged_at"

	// attrScannedAt and attrPointer hold the latest pointer. The pointer is stored
	// as its canonical JSON, which is the same form snapshot.PlanLatestWrite
	// compares, so what is stored and what the rule judges cannot drift apart.
	// attrScannedAt is a separate top-level attribute purely so an operator can
	// read the scan time without parsing the document.
	attrScannedAt = "scanned_at"
	attrPointer   = "pointer"
)

// chunkItem renders one chunk as an item. attrExpiresAt is deliberately absent:
// a freshly written chunk belongs to the snapshot about to be published, and only
// expireChunks adds a TTL, once the snapshot is superseded.
func chunkItem(snapshotID string, chunk snapshot.Chunk) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		attrPartition:     stringValue(snapshot.SnapshotPartition(snapshotID)),
		attrSort:          stringValue(snapshot.ChunkSort(chunk.Index)),
		attrFormatVersion: numberValue(int64(snapshot.FormatVersion)),
		attrSnapshotID:    stringValue(snapshotID),
		attrChunkIndex:    numberValue(int64(chunk.Index)),
		attrChunkCount:    numberValue(int64(chunk.Count)),
		attrChecksum:      stringValue(chunk.Checksum),
		attrPayload:       &types.AttributeValueMemberB{Value: chunk.Bytes},
	}
}

// stagingFormatVersion versions the staging marker on its own, independently of
// snapshot.FormatVersion.
//
// A marker is an operational record rather than a published wire format: no reader
// resolves one, and it holds a snapshot ID and a timestamp and no payload. Sharing
// the snapshot format's number would mean that the next intentional wire change
// turned every stored marker into one this package refuses to interpret, and the
// chunk sets they name would never be reclaimed. Bump this only when the marker's
// own attributes change.
const stagingFormatVersion = 1

// stagingItem renders one staging marker as an item.
//
// Unlike a chunk it carries a TTL from the moment it is written: the marker is a
// note that a publication is in flight, and a note nothing ever cleans up would
// outlive the chunks it points at. The window is the caller's, and has to be far
// longer than the interval between reclaim passes.
func stagingItem(snapshotID string, stagedAt, expiresAt time.Time) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		attrPartition:     stringValue(snapshot.LatestPartition),
		attrSort:          stringValue(snapshot.StagingSort(snapshotID)),
		attrFormatVersion: numberValue(stagingFormatVersion),
		attrSnapshotID:    stringValue(snapshotID),
		attrStagedAt:      stringValue(stagedAt.UTC().Format(time.RFC3339)),
		attrExpiresAt:     numberValue(expiresAt.UTC().Unix()),
	}
}

// stagingKey is the primary key of one snapshot's staging marker.
func stagingKey(snapshotID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		attrPartition: stringValue(snapshot.LatestPartition),
		attrSort:      stringValue(snapshot.StagingSort(snapshotID)),
	}
}

// decodeStagingItem rebuilds a staging marker and fails closed on anything it
// cannot account for, including a marker whose sort key disagrees with the snapshot
// ID it claims. A reclaimer decides what to expire from these, so a marker that
// named one snapshot under another's key would aim the expiry at the wrong chunks.
func decodeStagingItem(item map[string]types.AttributeValue) (snapshot.StagedSnapshot, error) {
	version, err := numberAttribute(item, attrFormatVersion)
	if err != nil {
		return snapshot.StagedSnapshot{}, err
	}
	if version != stagingFormatVersion {
		return snapshot.StagedSnapshot{}, fmt.Errorf("staging marker declares format version %d (want %d)", version, stagingFormatVersion)
	}

	snapshotID, err := stringAttribute(item, attrSnapshotID)
	if err != nil {
		return snapshot.StagedSnapshot{}, err
	}
	if err := snapshot.ValidateSnapshotID(snapshotID); err != nil {
		return snapshot.StagedSnapshot{}, err
	}
	sort, err := stringAttribute(item, attrSort)
	if err != nil {
		return snapshot.StagedSnapshot{}, err
	}
	if want := snapshot.StagingSort(snapshotID); sort != want {
		return snapshot.StagedSnapshot{}, fmt.Errorf("staging marker for snapshot %q is keyed %q, want %q", snapshotID, sort, want)
	}

	raw, err := stringAttribute(item, attrStagedAt)
	if err != nil {
		return snapshot.StagedSnapshot{}, err
	}
	stagedAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return snapshot.StagedSnapshot{}, fmt.Errorf("staging marker for snapshot %q has an unreadable staging time: %w", snapshotID, err)
	}
	return snapshot.StagedSnapshot{SnapshotID: snapshotID, StagedAt: stagedAt.UTC()}, nil
}

// latestKey is the primary key of the single pointer item.
func latestKey() map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		attrPartition: stringValue(snapshot.LatestPartition),
		attrSort:      stringValue(snapshot.LatestSort),
	}
}

// decodeChunkItem rebuilds a chunk from an item and fails closed on anything it
// cannot account for: an unknown format version, a missing or wrongly typed
// attribute, or a snapshot ID that is not the one the caller asked for.
//
// It does not check the payload checksum. snapshot.Assemble does that, along with
// the count, the index order, and the completeness of the set, and the pointer's
// checksum over the whole compressed stream is what makes the set as a whole
// self-checking. Repeating one of those checks here would not catch anything more.
func decodeChunkItem(snapshotID string, item map[string]types.AttributeValue) (snapshot.Chunk, error) {
	version, err := numberAttribute(item, attrFormatVersion)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	if version != int64(snapshot.FormatVersion) {
		return snapshot.Chunk{}, fmt.Errorf("stored chunk declares format version %d (want %d)", version, snapshot.FormatVersion)
	}

	storedID, err := stringAttribute(item, attrSnapshotID)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	if storedID != snapshotID {
		return snapshot.Chunk{}, fmt.Errorf("stored chunk is labelled snapshot %q but was read under %q", storedID, snapshotID)
	}

	index, err := numberAttribute(item, attrChunkIndex)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	count, err := numberAttribute(item, attrChunkCount)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	checksum, err := stringAttribute(item, attrChecksum)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	payload, err := binaryAttribute(item, attrPayload)
	if err != nil {
		return snapshot.Chunk{}, err
	}

	// The sort key is what a query orders by, so an item whose key disagrees with
	// its own index would be returned in a position its index does not justify.
	sort, err := stringAttribute(item, attrSort)
	if err != nil {
		return snapshot.Chunk{}, err
	}
	if want := snapshot.ChunkSort(int(index)); sort != want {
		return snapshot.Chunk{}, fmt.Errorf("stored chunk %d is keyed %q, want %q", index, sort, want)
	}

	if index < 0 || index > int64(maxInt32) || count < 0 || count > int64(maxInt32) {
		return snapshot.Chunk{}, fmt.Errorf("stored chunk has an out-of-range index %d or count %d", index, count)
	}
	return snapshot.Chunk{
		SnapshotID: snapshotID,
		Index:      int(index),
		Count:      int(count),
		Checksum:   checksum,
		Bytes:      payload,
	}, nil
}

// maxInt32 bounds decoded index and count values so they are safe as int on every
// platform this builds for, including a 32-bit Lambda architecture.
const maxInt32 = 1<<31 - 1

// latestItem renders the pointer as an item.
//
// attrPointer holds the whole pointer as canonical JSON rather than one attribute
// per field, which is what lets a compare-and-swap guard on a single value cover
// every part of the pointer at once.
func latestItem(latest snapshot.Latest) (map[string]types.AttributeValue, error) {
	document, err := json.Marshal(latest)
	if err != nil {
		return nil, fmt.Errorf("encode latest pointer: %w", err)
	}
	return map[string]types.AttributeValue{
		attrPartition:     stringValue(snapshot.LatestPartition),
		attrSort:          stringValue(snapshot.LatestSort),
		attrFormatVersion: numberValue(int64(latest.FormatVersion)),
		attrSnapshotID:    stringValue(latest.SnapshotID),
		attrScannedAt:     stringValue(latest.ScannedAt.UTC().Format(time.RFC3339)),
		attrPointer:       stringValue(string(document)),
	}, nil
}

// decodeLatestItem parses a stored pointer and validates it. An error means the
// stored pointer says nothing about which scan is newer, which LatestStore treats
// as replaceable on the publication path and as a hard failure on the read path.
func decodeLatestItem(item map[string]types.AttributeValue) (snapshot.Latest, error) {
	document, err := stringAttribute(item, attrPointer)
	if err != nil {
		return snapshot.Latest{}, err
	}
	var latest snapshot.Latest
	if err := json.Unmarshal([]byte(document), &latest); err != nil {
		return snapshot.Latest{}, fmt.Errorf("decode latest pointer: %w", err)
	}
	if err := latest.Validate(); err != nil {
		return snapshot.Latest{}, err
	}
	return latest, nil
}

func stringValue(value string) types.AttributeValue {
	return &types.AttributeValueMemberS{Value: value}
}

// attributeTypeCode is the DynamoDB type descriptor of a stored value, as the
// attribute_type condition function names it, or "" for a value this SDK version
// does not model. It lets a condition assert what type an attribute still holds
// without needing to compare the value itself.
func attributeTypeCode(value types.AttributeValue) string {
	switch value.(type) {
	case *types.AttributeValueMemberS:
		return "S"
	case *types.AttributeValueMemberN:
		return "N"
	case *types.AttributeValueMemberB:
		return "B"
	case *types.AttributeValueMemberSS:
		return "SS"
	case *types.AttributeValueMemberNS:
		return "NS"
	case *types.AttributeValueMemberBS:
		return "BS"
	case *types.AttributeValueMemberBOOL:
		return "BOOL"
	case *types.AttributeValueMemberNULL:
		return "NULL"
	case *types.AttributeValueMemberL:
		return "L"
	case *types.AttributeValueMemberM:
		return "M"
	default:
		return ""
	}
}

func numberValue(value int64) types.AttributeValue {
	return &types.AttributeValueMemberN{Value: strconv.FormatInt(value, 10)}
}

func stringAttribute(item map[string]types.AttributeValue, name string) (string, error) {
	value, exists := item[name]
	if !exists {
		return "", fmt.Errorf("stored item is missing attribute %q", name)
	}
	text, ok := value.(*types.AttributeValueMemberS)
	if !ok {
		return "", fmt.Errorf("stored item attribute %q is not a string", name)
	}
	return text.Value, nil
}

func numberAttribute(item map[string]types.AttributeValue, name string) (int64, error) {
	value, exists := item[name]
	if !exists {
		return 0, fmt.Errorf("stored item is missing attribute %q", name)
	}
	number, ok := value.(*types.AttributeValueMemberN)
	if !ok {
		return 0, fmt.Errorf("stored item attribute %q is not a number", name)
	}
	parsed, err := strconv.ParseInt(number.Value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("stored item attribute %q is not an integer: %w", name, err)
	}
	return parsed, nil
}

func binaryAttribute(item map[string]types.AttributeValue, name string) ([]byte, error) {
	value, exists := item[name]
	if !exists {
		return nil, fmt.Errorf("stored item is missing attribute %q", name)
	}
	binary, ok := value.(*types.AttributeValueMemberB)
	if !ok {
		return nil, fmt.Errorf("stored item attribute %q is not binary", name)
	}
	return binary.Value, nil
}
