// Package dynamo stores published ENS snapshots in a single DynamoDB table.
//
// It is the storage backend for the contract in internal/snapshot and nothing
// more: it decides what to write by calling snapshot.ValidatePutChunks,
// snapshot.PlanChunkWrite, and snapshot.PlanLatestWrite, so the chunk-immutability
// and pointer-ordering rules have exactly one definition and this package cannot
// drift from the local fakes that tests are written against.
//
// Every read is strongly consistent. A publisher writes chunks, reads them back,
// verifies them, and only then moves the pointer, so an eventually consistent read
// could miss a chunk it had just written and either fail a sound publication or,
// worse, let snapshot.PlanChunkWrite mistake a stored chunk for a missing one.
//
// The table needs a string partition key named pk, a string sort key named sk, and
// TTL enabled on expires_at. Provisioning it is not this package's job: nothing here
// creates, alters, or deletes a table.
package dynamo

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/snapshot"
)

// API is the DynamoDB surface this package uses. *dynamodb.Client satisfies it, and
// tests inject a local fake, so no test needs credentials or a network.
type API interface {
	BatchWriteItem(ctx context.Context, params *dynamodb.BatchWriteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error)
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

const (
	// maxBatchItems is DynamoDB's BatchWriteItem item limit.
	maxBatchItems = 25
	// maxBatchBytes keeps a batch well inside BatchWriteItem's 16 MB request
	// limit. Chunks are capped at snapshot.MaxChunkBytes, so 25 of them cannot
	// reach this on their own; the cap is here so a future larger chunk size
	// cannot silently start producing oversized requests.
	maxBatchBytes = 8 << 20

	// defaultUnprocessedRetries bounds how many times a batch write re-sends only
	// the items DynamoDB reported as unprocessed.
	defaultUnprocessedRetries = 8

	// maxChunkQueryPages bounds a chunk query. At roughly five 192 KiB chunks per
	// 1 MB page this covers far more chunks than chunkSortDigits allows.
	maxChunkQueryPages = 512

	// maxStagingQueryPages bounds the staging-marker query. Markers are a few tens
	// of bytes each and exist only between a publisher's first chunk write and its
	// pointer write, so one page holds thousands of them; the bound is here for the
	// same reason the chunk one is, to keep a paging loop finite.
	maxStagingQueryPages = 16

	// maxPointerAttempts bounds the compare-and-swap loop in PutLatest. Each
	// attempt re-reads the pointer, so a publisher that loses the race this many
	// times in a row is contending with a publisher that keeps winning, and the
	// snapshot already published is the one that should keep serving.
	maxPointerAttempts = 4

	// maxQuarantineAttempts bounds the search for a free quarantine key.
	maxQuarantineAttempts = 100

	baseRetryDelay = 50 * time.Millisecond
	maxRetryDelay  = 2 * time.Second
)

// quarantineSortPrefix begins the sort key of a preserved unusable pointer.
//
// Reads address the pointer by its exact primary key with GetItem, and chunk reads
// query the SNAPSHOT# partition for keys beginning with snapshot.ChunkSortPrefix, so
// nothing on the read path can return a quarantined item. The one query that does
// scan the META partition by sort-key prefix, StagedSnapshots, asks for
// snapshot.StagingSortPrefix, which this prefix does not begin with. Any future
// query over that partition has to exclude this prefix explicitly.
const quarantineSortPrefix = snapshot.LatestSort + "-INVALID#"

// Store implements snapshot.Store, and adds ExpireChunks for the TTL a real table
// applies to superseded snapshots.
type Store struct {
	api                API
	table              string
	unprocessedRetries int
	sleep              func(ctx context.Context, delay time.Duration) error
}

// Options configures a Store.
type Options struct {
	// Table is the DynamoDB table name. Required.
	Table string
	// UnprocessedRetries bounds batch-write retries of unprocessed items. Zero
	// selects defaultUnprocessedRetries; a negative value disables retrying.
	UnprocessedRetries int
	// Sleep waits between unprocessed-item retries and must return the context
	// error if the context ends first. Tests inject a sleeper that does not wait.
	Sleep func(ctx context.Context, delay time.Duration) error
}

// New returns a Store over an existing DynamoDB API.
func New(api API, options Options) (*Store, error) {
	if api == nil {
		return nil, fmt.Errorf("dynamodb api is required")
	}
	if options.Table == "" {
		return nil, fmt.Errorf("dynamodb table name is required")
	}
	retries := options.UnprocessedRetries
	if retries == 0 {
		retries = defaultUnprocessedRetries
	}
	if retries < 0 {
		retries = 0
	}
	sleep := options.Sleep
	if sleep == nil {
		sleep = sleepWithContext
	}
	return &Store{api: api, table: options.Table, unprocessedRetries: retries, sleep: sleep}, nil
}

// Store satisfies the contract's full publisher surface, and the staging registry
// a publisher needs so an abandoned chunk set stays findable.
var (
	_ snapshot.Store        = (*Store)(nil)
	_ snapshot.StagingStore = (*Store)(nil)
)

// PutChunks writes the chunks of one snapshot, applying the ChunkStore rule to
// whatever is already stored under that snapshot ID: an identical set is a no-op, a
// partial set is completed index by index, and a conflicting set is refused.
//
// The stored set is read first, and a read failure is returned rather than treated
// as "nothing stored". Chunks that cannot be read are evidence of nothing, and
// mistaking a throttled or cancelled read for an empty snapshot would let a retry
// overwrite the snapshot the pointer names.
func (s *Store) PutChunks(ctx context.Context, snapshotID string, chunks []snapshot.Chunk) error {
	if err := snapshot.ValidatePutChunks(ctx, snapshotID, chunks); err != nil {
		return err
	}

	stored, err := s.GetChunks(ctx, snapshotID)
	if err != nil && !errors.Is(err, snapshot.ErrNotFound) {
		return fmt.Errorf("read stored chunks of snapshot %s: %w", snapshotID, err)
	}

	decision, missing, err := snapshot.PlanChunkWrite(stored, chunks)
	if err != nil {
		return err
	}
	switch decision {
	case snapshot.ChunkWriteSkip:
		return nil
	case snapshot.ChunkWriteResume:
		requests := make([]types.WriteRequest, 0, len(missing))
		for _, chunk := range missing {
			requests = append(requests, types.WriteRequest{
				PutRequest: &types.PutRequest{Item: chunkItem(snapshotID, chunk)},
			})
		}
		return s.batchWrite(ctx, requests)
	default:
		// snapshot.ChunkWriteRefuse, and anything a future decision adds that this
		// backend does not understand. Refusing is the safe reading of both.
		return snapshot.ChunkConflictError(snapshotID)
	}
}

// GetChunks returns a snapshot's stored chunks in index order, or ErrNotFound when
// the snapshot has none. It fails closed on any item it cannot fully account for.
//
// The returned set may be incomplete, which is what an interrupted write leaves
// behind. Completeness is snapshot.Assemble's judgement, so PutChunks can resume a
// partial set while Read still refuses to serve one.
func (s *Store) GetChunks(ctx context.Context, snapshotID string) ([]snapshot.Chunk, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := snapshot.ValidateSnapshotID(snapshotID); err != nil {
		return nil, err
	}

	var (
		chunks   []snapshot.Chunk
		startKey map[string]types.AttributeValue
	)
	for page := 0; page < maxChunkQueryPages; page++ {
		output, err := s.api.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.table),
			KeyConditionExpression: aws.String("#pk = :pk AND begins_with(#sk, :prefix)"),
			ExpressionAttributeNames: map[string]string{
				"#pk": attrPartition,
				"#sk": attrSort,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":     stringValue(snapshot.SnapshotPartition(snapshotID)),
				":prefix": stringValue(snapshot.ChunkSortPrefix),
			},
			// Zero-padded sort keys make lexical order index order.
			ScanIndexForward:  aws.Bool(true),
			ConsistentRead:    aws.Bool(true),
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("query chunks of snapshot %s: %w", snapshotID, err)
		}
		for _, item := range output.Items {
			chunk, err := decodeChunkItem(snapshotID, item)
			if err != nil {
				return nil, fmt.Errorf("snapshot %s: %w", snapshotID, err)
			}
			chunks = append(chunks, chunk)
		}
		if len(output.LastEvaluatedKey) == 0 {
			if len(chunks) == 0 {
				return nil, fmt.Errorf("chunks for snapshot %s: %w", snapshotID, snapshot.ErrNotFound)
			}
			return chunks, nil
		}
		startKey = output.LastEvaluatedKey
	}
	return nil, fmt.Errorf("chunks of snapshot %s span more than %d query pages", snapshotID, maxChunkQueryPages)
}

// DeleteChunks removes a snapshot's chunks immediately. TTL is how a superseded
// snapshot is normally reclaimed, because it leaves a recovery window; this is the
// unconditional removal, for a caller that has decided a snapshot must go now.
// Removing a snapshot that has no chunks succeeds, so the call is idempotent.
func (s *Store) DeleteChunks(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := snapshot.ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	keys, err := s.chunkKeys(ctx, snapshotID)
	if err != nil {
		return err
	}
	requests := make([]types.WriteRequest, 0, len(keys))
	for _, key := range keys {
		requests = append(requests, types.WriteRequest{
			DeleteRequest: &types.DeleteRequest{Key: key},
		})
	}
	return s.batchWrite(ctx, requests)
}

// ExpireChunks sets the table's TTL attribute on every chunk of a snapshot that is
// no longer the published one, so it stays readable for a recovery window and is
// then reclaimed without any further call.
//
// DynamoDB deletes expired items at its own pace, typically within 48 hours of the
// timestamp, so expiresAt is the earliest the chunks may disappear and not a
// deadline by which they will. Callers must size the window on the "at least" reading.
//
// It refuses to expire the snapshot the latest pointer names, because expiring the
// live snapshot would empty the table under readers that resolve the pointer
// successfully. A pointer that is stored but unusable is refused too: it cannot
// prove which snapshot it names, so it cannot prove this is not that one.
//
// A pointer that is absent is not the same thing. Nothing is published, so no
// reader can be resolving any snapshot and this one cannot be the live one.
// Refusing then would leave a chunk set abandoned before the first successful
// publication unreclaimable, which is exactly the case where a publication that
// keeps failing would otherwise grow the table on every attempt.
//
// A snapshot whose chunks carry a TTL must not be published again: the TTL is not
// part of snapshot.Chunk, so PlanChunkWrite would see an identical set, skip the
// write, and leave the expiry in place. Snapshot IDs are unique per scan, so this
// only matters to a caller that reuses one deliberately.
func (s *Store) ExpireChunks(ctx context.Context, snapshotID string, expiresAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := snapshot.ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	if expiresAt.IsZero() {
		return fmt.Errorf("an expiry time is required to expire snapshot %s", snapshotID)
	}

	published, err := s.GetLatest(ctx)
	switch {
	case err == nil:
		if published.SnapshotID == snapshotID {
			return fmt.Errorf("refusing to expire snapshot %s because the latest pointer still names it", snapshotID)
		}
	case errors.Is(err, snapshot.ErrNotFound):
		// Nothing is published, so nothing is live.
	default:
		return fmt.Errorf("cannot expire snapshot %s without a usable latest pointer: %w", snapshotID, err)
	}

	keys, err := s.chunkKeys(ctx, snapshotID)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return fmt.Errorf("chunks for snapshot %s: %w", snapshotID, snapshot.ErrNotFound)
	}

	expiry := numberValue(expiresAt.UTC().Unix())
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, err := s.api.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:           aws.String(s.table),
			Key:                 key,
			UpdateExpression:    aws.String("SET #expires = :expires"),
			ConditionExpression: aws.String("attribute_exists(#pk)"),
			ExpressionAttributeNames: map[string]string{
				"#expires": attrExpiresAt,
				"#pk":      attrPartition,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{":expires": expiry},
		})
		if err == nil {
			continue
		}
		if conditionFailed(err) {
			// The chunk was reclaimed between the query and the update, which is
			// exactly what an earlier expiry does. There is nothing left to expire.
			continue
		}
		return fmt.Errorf("expire chunks of snapshot %s: %w", snapshotID, err)
	}
	return nil
}

// StageSnapshot records that this publisher is about to write one snapshot's
// chunks, so the set stays findable if the publication never reaches the pointer.
//
// The write is unconditional, which is the rule the contract states: a publisher
// that claims the same snapshot ID again refreshes the staging time and so renews
// the grace period a reclaimer waits out. A conditional write that preserved the
// first claim would let a reclaimer decide a set was abandoned while a second
// publisher was still writing it.
func (s *Store) StageSnapshot(ctx context.Context, snapshotID string, stagedAt, expiresAt time.Time) error {
	if err := snapshot.ValidateStaging(ctx, snapshotID, stagedAt, expiresAt); err != nil {
		return err
	}
	_, err := s.api.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.table),
		Item:      stagingItem(snapshotID, stagedAt, expiresAt),
	})
	if err != nil {
		return fmt.Errorf("stage snapshot %s: %w", snapshotID, err)
	}
	return nil
}

// UnstageSnapshot removes a snapshot's staging marker. Removing one that is not
// there succeeds, so a publisher may unstage without first reading.
func (s *Store) UnstageSnapshot(ctx context.Context, snapshotID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := snapshot.ValidateSnapshotID(snapshotID); err != nil {
		return err
	}
	return s.batchWrite(ctx, []types.WriteRequest{
		{DeleteRequest: &types.DeleteRequest{Key: stagingKey(snapshotID)}},
	})
}

// StagedSnapshots returns every staging marker, in sort-key order, which for these
// keys is snapshot ID order.
//
// It fails closed on a marker it cannot decode rather than skipping it, so a
// reclaimer never acts on a partial view of what is staged. A marker only a future
// format version could write therefore defers reclaiming rather than mis-aiming it,
// and the marker's own TTL still bounds how long that can last.
func (s *Store) StagedSnapshots(ctx context.Context) ([]snapshot.StagedSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var (
		staged   []snapshot.StagedSnapshot
		startKey map[string]types.AttributeValue
	)
	for page := 0; page < maxStagingQueryPages; page++ {
		output, err := s.api.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.table),
			KeyConditionExpression: aws.String("#pk = :pk AND begins_with(#sk, :prefix)"),
			ExpressionAttributeNames: map[string]string{
				"#pk": attrPartition,
				"#sk": attrSort,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":     stringValue(snapshot.LatestPartition),
				":prefix": stringValue(snapshot.StagingSortPrefix),
			},
			ScanIndexForward:  aws.Bool(true),
			ConsistentRead:    aws.Bool(true),
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("query staged snapshots: %w", err)
		}
		for _, item := range output.Items {
			entry, err := decodeStagingItem(item)
			if err != nil {
				return nil, err
			}
			staged = append(staged, entry)
		}
		if len(output.LastEvaluatedKey) == 0 {
			return staged, nil
		}
		startKey = output.LastEvaluatedKey
	}
	return nil, fmt.Errorf("staged snapshots span more than %d query pages", maxStagingQueryPages)
}

// GetLatest returns the published pointer, ErrNotFound when nothing is published,
// and an error when a pointer is stored but does not read and validate. It never
// repairs or replaces one: a reader has no basis for guessing what an unusable
// pointer meant, and the pointer is the only evidence of why publication is stuck.
func (s *Store) GetLatest(ctx context.Context) (snapshot.Latest, error) {
	if err := ctx.Err(); err != nil {
		return snapshot.Latest{}, err
	}
	stored, err := s.readPointer(ctx)
	if err != nil {
		return snapshot.Latest{}, err
	}
	if stored.item == nil {
		return snapshot.Latest{}, fmt.Errorf("latest snapshot pointer: %w", snapshot.ErrNotFound)
	}
	if stored.latest == nil {
		return snapshot.Latest{}, fmt.Errorf("stored latest pointer is unusable: %w", stored.reason)
	}
	return stored.latest.Clone(), nil
}

// PutLatest moves the pointer forward under the LatestStore ordering rule, as a
// compare-and-swap against the exact item it read.
//
// A read followed by an unconditional write would let two overlapping publishers
// both decide they may proceed and let the slower one land last. Instead the write
// is conditional on the pointer still being what snapshot.PlanLatestWrite judged, so
// a publisher that loses the race re-reads and submits its scan to the rule again.
// It either turns out to be newer than the pointer that won, or it is refused with
// ErrPointerConflict, which is a lost race and not a transient failure.
func (s *Store) PutLatest(ctx context.Context, latest snapshot.Latest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := latest.Validate(); err != nil {
		return err
	}
	item, err := latestItem(latest)
	if err != nil {
		return err
	}

	for attempt := 0; attempt < maxPointerAttempts; attempt++ {
		stored, err := s.readPointer(ctx)
		if err != nil {
			return err
		}

		// A stored pointer that does not read and validate says nothing about which
		// scan is newer, so the rule is applied as if nothing were stored.
		write, err := snapshot.PlanLatestWrite(stored.latest, latest)
		if err != nil {
			return err
		}
		if !write {
			return nil
		}

		if stored.item != nil && stored.latest == nil {
			// Replacing an unusable pointer destroys the only record of why
			// publication was stuck, so it is preserved first, and a failure to
			// preserve it fails the publication instead.
			if err := s.quarantinePointer(ctx, stored.item); err != nil {
				return fmt.Errorf("preserve the unusable latest pointer before replacing it: %w", err)
			}
		}

		guard := pointerGuard(stored.item)
		_, err = s.api.PutItem(ctx, &dynamodb.PutItemInput{
			TableName:                 aws.String(s.table),
			Item:                      item,
			ConditionExpression:       aws.String(guard.expression),
			ExpressionAttributeNames:  guard.names,
			ExpressionAttributeValues: guard.values,
		})
		if err == nil {
			return nil
		}
		if !conditionFailed(err) {
			return fmt.Errorf("write latest pointer: %w", err)
		}
		// Someone changed the pointer between the read and the write. Re-read and
		// let the ordering rule judge whatever is there now.
	}
	return fmt.Errorf("%w: the latest pointer changed under all %d attempts to publish snapshot %s",
		snapshot.ErrPointerConflict, maxPointerAttempts, latest.SnapshotID)
}

// storedPointer is what a publisher read from the pointer item.
type storedPointer struct {
	// item is the raw stored item, and is nil when nothing is stored.
	item map[string]types.AttributeValue
	// latest is the parsed pointer, and is nil both when no item is stored and
	// when the stored item does not read and validate.
	latest *snapshot.Latest
	// reason records why a stored item did not parse.
	reason error
}

func (s *Store) readPointer(ctx context.Context) (storedPointer, error) {
	output, err := s.api.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.table),
		Key:            latestKey(),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return storedPointer{}, fmt.Errorf("read latest pointer: %w", err)
	}
	if len(output.Item) == 0 {
		return storedPointer{}, nil
	}
	latest, err := decodeLatestItem(output.Item)
	if err != nil {
		return storedPointer{item: output.Item, reason: err}, nil
	}
	return storedPointer{item: output.Item, latest: &latest}, nil
}

// conditionalWrite is a DynamoDB condition expression and its bindings.
type conditionalWrite struct {
	expression string
	names      map[string]string
	values     map[string]types.AttributeValue
}

// pointerGuard builds the compare-and-swap condition from exactly what the
// publisher read, so any change to the item in between makes the write fail rather
// than overwrite the publisher that made it.
//
// Guarding on the whole stored pointer document rather than on its scan time covers
// an item that carries no usable pointer as well as one that does, and it needs no
// assumption about which attributes an unusable item happens to have.
func pointerGuard(item map[string]types.AttributeValue) conditionalWrite {
	if item == nil {
		return conditionalWrite{
			expression: "attribute_not_exists(#pk)",
			names:      map[string]string{"#pk": attrPartition},
		}
	}
	current, err := stringAttribute(item, attrPointer)
	if err != nil {
		// The item exists but holds no readable pointer document, so its absence
		// is the only thing there is to compare against.
		return conditionalWrite{
			expression: "attribute_not_exists(#pointer)",
			names:      map[string]string{"#pointer": attrPointer},
		}
	}
	return conditionalWrite{
		expression: "#pointer = :current",
		names:      map[string]string{"#pointer": attrPointer},
		values:     map[string]types.AttributeValue{":current": stringValue(current)},
	}
}

// quarantinePointer copies an unusable pointer item verbatim to a sort key no read
// addresses. It never overwrites an earlier copy, so repeated attempts to publish
// past the same unusable pointer accumulate rather than erase each other.
func (s *Store) quarantinePointer(ctx context.Context, item map[string]types.AttributeValue) error {
	for attempt := 0; attempt < maxQuarantineAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		preserved := make(map[string]types.AttributeValue, len(item))
		for name, value := range item {
			preserved[name] = value
		}
		preserved[attrSort] = stringValue(quarantineSort(attempt))

		_, err := s.api.PutItem(ctx, &dynamodb.PutItemInput{
			TableName:                aws.String(s.table),
			Item:                     preserved,
			ConditionExpression:      aws.String("attribute_not_exists(#sk)"),
			ExpressionAttributeNames: map[string]string{"#sk": attrSort},
		})
		if err == nil {
			return nil
		}
		if !conditionFailed(err) {
			return err
		}
	}
	return fmt.Errorf("all %d quarantine keys are already taken", maxQuarantineAttempts)
}

func quarantineSort(attempt int) string {
	return fmt.Sprintf("%s%03d", quarantineSortPrefix, attempt)
}

// chunkKeys returns the primary key of every stored chunk of a snapshot, projecting
// only the key attributes so a payload is never read just to address it.
func (s *Store) chunkKeys(ctx context.Context, snapshotID string) ([]map[string]types.AttributeValue, error) {
	var (
		keys     []map[string]types.AttributeValue
		startKey map[string]types.AttributeValue
	)
	for page := 0; page < maxChunkQueryPages; page++ {
		output, err := s.api.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.table),
			KeyConditionExpression: aws.String("#pk = :pk AND begins_with(#sk, :prefix)"),
			ProjectionExpression:   aws.String("#pk, #sk"),
			ExpressionAttributeNames: map[string]string{
				"#pk": attrPartition,
				"#sk": attrSort,
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":     stringValue(snapshot.SnapshotPartition(snapshotID)),
				":prefix": stringValue(snapshot.ChunkSortPrefix),
			},
			ScanIndexForward:  aws.Bool(true),
			ConsistentRead:    aws.Bool(true),
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("query chunk keys of snapshot %s: %w", snapshotID, err)
		}
		for _, item := range output.Items {
			partition, err := stringAttribute(item, attrPartition)
			if err != nil {
				return nil, err
			}
			sort, err := stringAttribute(item, attrSort)
			if err != nil {
				return nil, err
			}
			keys = append(keys, map[string]types.AttributeValue{
				attrPartition: stringValue(partition),
				attrSort:      stringValue(sort),
			})
		}
		if len(output.LastEvaluatedKey) == 0 {
			return keys, nil
		}
		startKey = output.LastEvaluatedKey
	}
	return nil, fmt.Errorf("chunk keys of snapshot %s span more than %d query pages", snapshotID, maxChunkQueryPages)
}

// batchWrite sends write requests in bounded batches.
func (s *Store) batchWrite(ctx context.Context, requests []types.WriteRequest) error {
	for _, batch := range splitWriteRequests(requests) {
		if err := s.writeBatch(ctx, batch); err != nil {
			return err
		}
	}
	return nil
}

// writeBatch sends one batch and re-sends only the items DynamoDB reported as
// unprocessed, a bounded number of times.
//
// Unprocessed items are the one signal retried here, because they are the one
// signal that says the request itself was fine and part of it was shed. A returned
// error is surfaced: the SDK already retries what is safely retryable at the
// transport layer, and a second retry loop over whole requests here would turn one
// throttled write into an unbounded amount of work.
func (s *Store) writeBatch(ctx context.Context, batch []types.WriteRequest) error {
	pending := batch
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		output, err := s.api.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{s.table: pending},
		})
		if err != nil {
			return fmt.Errorf("batch write of %d items: %w", len(pending), err)
		}

		unprocessed := output.UnprocessedItems[s.table]
		if len(unprocessed) == 0 {
			return nil
		}
		if len(unprocessed) > len(pending) {
			return fmt.Errorf("batch write reported %d unprocessed items from a batch of %d", len(unprocessed), len(pending))
		}
		if attempt >= s.unprocessedRetries {
			return fmt.Errorf("batch write left %d of %d items unprocessed after %d retries",
				len(unprocessed), len(batch), s.unprocessedRetries)
		}
		pending = unprocessed
		if err := s.sleep(ctx, retryDelay(attempt)); err != nil {
			return err
		}
	}
}

// splitWriteRequests groups requests into batches within both of BatchWriteItem's
// limits, the item count and the request size.
func splitWriteRequests(requests []types.WriteRequest) [][]types.WriteRequest {
	var batches [][]types.WriteRequest
	start, size := 0, 0
	for i, request := range requests {
		itemSize := writeRequestBytes(request)
		full := i-start == maxBatchItems
		oversized := i > start && size+itemSize > maxBatchBytes
		if full || oversized {
			batches = append(batches, requests[start:i])
			start, size = i, 0
		}
		size += itemSize
	}
	if start < len(requests) {
		batches = append(batches, requests[start:])
	}
	return batches
}

func writeRequestBytes(request types.WriteRequest) int {
	if request.PutRequest != nil {
		return itemBytes(request.PutRequest.Item)
	}
	if request.DeleteRequest != nil {
		return itemBytes(request.DeleteRequest.Key)
	}
	return 0
}

// itemBytes estimates what one item costs in a request. Binary attributes travel
// base64 encoded, which is the size the request limit sees, so the estimate has to
// count the encoded length rather than the raw one.
func itemBytes(item map[string]types.AttributeValue) int {
	total := 0
	for name, value := range item {
		total += len(name)
		switch typed := value.(type) {
		case *types.AttributeValueMemberS:
			total += len(typed.Value)
		case *types.AttributeValueMemberN:
			total += len(typed.Value)
		case *types.AttributeValueMemberB:
			total += base64.StdEncoding.EncodedLen(len(typed.Value))
		}
	}
	return total
}

// retryDelay backs off exponentially from baseRetryDelay up to maxRetryDelay.
func retryDelay(attempt int) time.Duration {
	delay := baseRetryDelay
	for i := 0; i < attempt; i++ {
		if delay >= maxRetryDelay {
			return maxRetryDelay
		}
		delay *= 2
	}
	if delay > maxRetryDelay {
		return maxRetryDelay
	}
	return delay
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// conditionFailed reports whether an error is DynamoDB refusing a conditional
// write, which is a lost compare-and-swap rather than a failure to reach the table.
func conditionFailed(err error) bool {
	var failed *types.ConditionalCheckFailedException
	return errors.As(err, &failed)
}
