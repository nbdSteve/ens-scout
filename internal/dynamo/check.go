package dynamo

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"ens-scrape/internal/checkstore"
)

// Check item attribute names. The key layout itself comes from internal/checkstore,
// for the same reason the snapshot layout comes from internal/snapshot: the shared
// store is a contract, so one package decides what an item is called.
const (
	// attrCharged is the running total of one window, as a number. It is only ever
	// changed by an atomic conditional add, never read and written back.
	attrCharged = "charged"

	// attrWindowStart is which window a counter belongs to, as RFC3339. The sort key
	// already encodes it as Unix seconds; this is here so an operator reading the
	// table can see it, the same way attrStagedAt is readable.
	attrWindowStart = "window_start"

	// attrCacheKey repeats the key attrPartition encodes, so a read can prove the
	// item it got back is the one it asked for rather than trusting the envelope.
	attrCacheKey = "cache_key"

	// attrBody is a cached rendered response, as binary. It is stored and returned
	// unchanged, because the instant in it is the instant the ENS index was really
	// read at and re-rendering would replace that with the time of the hit.
	attrBody = "body"
)

// checkFormatVersion versions the check items on their own, independently of
// snapshot.FormatVersion and of stagingFormatVersion.
//
// Nothing resolves one of these items as a published wire format: a counter holds a
// number and a cached entry holds bytes some earlier response already rendered, and
// both expire within minutes. Sharing the snapshot format's number would mean the
// next intentional snapshot wire change made every stored counter unreadable, which
// would hand every client a fresh allowance at the moment of a deployment. Bump this
// only when these attributes change.
const checkFormatVersion = 1

// maxCacheBodyBytes bounds a cached response.
//
// A binary attribute travels base64 encoded, so the request sees four bytes for every
// three, and 192 KiB encodes to about 256 KB. That leaves DynamoDB's 400 KB item
// limit a wide margin for the keys and the attribute names, the same margin
// snapshot.MaxChunkBytes leaves. A real check response is a few kilobytes, so this is
// not a working limit but a refusal to write an item that cannot be stored.
const maxCacheBodyBytes = 192 << 10

// CheckAPI is the DynamoDB surface the check store uses.
//
// It is deliberately a subset of API rather than API itself. The publisher's role
// grants exactly the actions API names, and this store adds none of its own, so
// nothing here can widen that policy; and a serving deployment can be given a role
// narrower still, because a read path must not be able to write a chunk or move the
// pointer even by mistake. *dynamodb.Client satisfies it, and tests inject a local
// fake, so no test needs credentials or a network.
type CheckAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error)
}

// API is a superset of CheckAPI, so the publisher's client serves both and the
// action set the infrastructure grants stays the one API describes.
var _ CheckAPI = (API)(nil)

// CheckStore is the DynamoDB implementation of checkstore.Store.
//
// It is a separate type from Store on purpose. Store publishes snapshots; this one
// charges allowances and caches rendered answers, and neither can perform the other's
// writes. A deployment that serves the read API therefore holds a value that cannot
// move the latest pointer.
type CheckStore struct {
	api   CheckAPI
	table string
}

// CheckOptions configures a CheckStore.
type CheckOptions struct {
	// Table is the DynamoDB table name. Required. Check items share the publisher's
	// table: they need the same string partition key, the same string sort key, and
	// TTL on the same attribute, and they take partition keys internal/checkstore
	// owns, which no snapshot read or query can address.
	Table string
}

// NewCheckStore returns a CheckStore over an existing DynamoDB API.
func NewCheckStore(api CheckAPI, options CheckOptions) (*CheckStore, error) {
	if api == nil {
		return nil, fmt.Errorf("dynamodb api is required")
	}
	if options.Table == "" {
		return nil, fmt.Errorf("dynamodb table name is required")
	}
	return &CheckStore{api: api, table: options.Table}, nil
}

// CheckStore satisfies the whole shared-store contract.
var _ checkstore.Store = (*CheckStore)(nil)

// Charge applies one allowance charge as a single conditional UpdateItem.
//
// This is the whole reason a shared counter is safe to charge from many instances at
// once. DynamoDB evaluates the condition and the addition against one item under one
// lock, so either the entire cost is added or nothing is, whatever else is happening
// to that item. There is no read, no version attribute, and no compare-and-swap loop:
// a refusal is DynamoDB declining the condition, and a refused charge changed nothing.
//
// The window is part of the sort key, so the item this addresses can only ever hold
// the window it names. That is what makes an unswept counter harmless: TTL removal is
// asynchronous and may lag by hours, but a stale counter belongs to a closed window
// and no live charge addresses it.
//
// A returned error is never a decision. The SDK already retries what is safely
// retryable at the transport layer, and this is a serving path under a request
// deadline, so there is no second retry loop here: a throttled table refuses the
// request rather than spending the deadline on it.
func (c *CheckStore) Charge(ctx context.Context, kind checkstore.Kind, key string, cost int64, now time.Time, window checkstore.Window) (checkstore.Charge, error) {
	if err := ctx.Err(); err != nil {
		// A cancelled or expired context says nothing about the allowance, so it is
		// neither an acceptance nor a refusal.
		return checkstore.Charge{}, err
	}
	if err := checkstore.ValidateCharge(kind, key, cost, window); err != nil {
		return checkstore.Charge{}, err
	}

	start := window.Start(now)
	end := start.Add(window.Period)
	// A counter outlives its own window by one period. The window is in the key, so
	// nothing depends on this for correctness; it exists so a charge that arrives at
	// the very end of a window still adds to the total that window really holds
	// rather than to an item TTL removed a moment earlier.
	expiresAt := end.Add(window.Period)

	_, err := c.api.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(c.table),
		Key: map[string]types.AttributeValue{
			attrPartition: stringValue(checkstore.RatePartition(kind, key)),
			attrSort:      stringValue(checkstore.WindowSort(start)),
		},
		UpdateExpression: aws.String("SET #charged = if_not_exists(#charged, :zero) + :cost, " +
			"#version = :version, #start = :start, #expires = if_not_exists(#expires, :expires)"),
		// The condition is the limit. An absent counter is a window nothing has
		// charged yet, and ValidateCharge has already refused a cost larger than the
		// whole window, so the first charge always fits. Otherwise the stored total
		// must leave room for the entire cost: a request that needs four upstream
		// calls is refused whole rather than part-charged into the three that are
		// left, because a partial charge would spend budget on work that will not
		// happen.
		ConditionExpression: aws.String("attribute_not_exists(#charged) OR #charged <= :headroom"),
		ExpressionAttributeNames: map[string]string{
			"#charged": attrCharged,
			"#version": attrFormatVersion,
			"#start":   attrWindowStart,
			"#expires": attrExpiresAt,
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":zero":     numberValue(0),
			":cost":     numberValue(cost),
			":headroom": numberValue(window.Limit - cost),
			":version":  numberValue(checkFormatVersion),
			":start":    stringValue(start.Format(time.RFC3339)),
			":expires":  numberValue(expiresAt.Unix()),
		},
	})
	if err != nil {
		if conditionFailed(err) {
			return checkstore.Charge{RetryAt: end}, nil
		}
		// The key is a keyed digest of a client address, not the address, and no
		// candidate label reaches here, so the message names the allowance and not
		// what spent it.
		return checkstore.Charge{}, fmt.Errorf("charge %d against the %s allowance: %w", cost, kind, err)
	}
	return checkstore.Charge{OK: true}, nil
}

// Load reads one cached response.
//
// The read is strongly consistent, like every other read in this package. The cache
// exists to keep a repeated request off the ENS index, so an eventually consistent
// miss would spend exactly the upstream budget the cache is there to save.
//
// An expired entry is a miss rather than a stale hit, judged against the caller's
// clock rather than against TTL removal, which is asynchronous and may lag.
func (c *CheckStore) Load(ctx context.Context, key string, now time.Time) (checkstore.Entry, bool, error) {
	if err := ctx.Err(); err != nil {
		return checkstore.Entry{}, false, err
	}
	if err := checkstore.ValidateKey(key); err != nil {
		return checkstore.Entry{}, false, err
	}

	output, err := c.api.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(c.table),
		Key:            cacheKey(key),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return checkstore.Entry{}, false, fmt.Errorf("read a cached check answer: %w", err)
	}
	if len(output.Item) == 0 {
		return checkstore.Entry{}, false, nil
	}

	entry, err := decodeCacheItem(key, output.Item)
	if err != nil {
		// A stored answer that cannot be accounted for is a failure and not a miss.
		// Treating it as a miss would hide a wrong item behind an extra upstream call
		// for as long as it stayed stored.
		return checkstore.Entry{}, false, err
	}
	if !entry.ExpiresAt.After(now) {
		return checkstore.Entry{}, false, nil
	}
	return entry, true, nil
}

// Store writes one cached response, overwriting whatever is stored under the key.
//
// A repeated write is accepted rather than refused: two instances that both missed
// and both read the index produced two honest answers, and either is a correct thing
// to have cached. Each carries its own expiry, so neither can be served past the
// lifetime it was rendered with.
func (c *CheckStore) Store(ctx context.Context, key string, entry checkstore.Entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := checkstore.ValidateKey(key); err != nil {
		return err
	}
	if err := entry.Validate(); err != nil {
		return err
	}
	if len(entry.Body) > maxCacheBodyBytes {
		return fmt.Errorf("a cached check answer of %d bytes exceeds the %d byte item bound",
			len(entry.Body), maxCacheBodyBytes)
	}

	item := cacheKey(key)
	item[attrFormatVersion] = numberValue(checkFormatVersion)
	item[attrCacheKey] = stringValue(key)
	item[attrBody] = &types.AttributeValueMemberB{Value: entry.Body}
	item[attrExpiresAt] = numberValue(entry.ExpiresAt.UTC().Unix())

	_, err := c.api.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(c.table),
		Item:      item,
	})
	if err != nil {
		return fmt.Errorf("cache a check answer: %w", err)
	}
	return nil
}

func cacheKey(key string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		attrPartition: stringValue(checkstore.ResultPartition(key)),
		attrSort:      stringValue(checkstore.ResultSort),
	}
}

// decodeCacheItem rebuilds a cached entry and fails closed on anything it cannot
// account for, including an item whose recorded key disagrees with the one it was read
// under. The body is returned to a client verbatim, so an item that is not the one
// asked for would answer one request with another's results.
func decodeCacheItem(key string, item map[string]types.AttributeValue) (checkstore.Entry, error) {
	version, err := numberAttribute(item, attrFormatVersion)
	if err != nil {
		return checkstore.Entry{}, err
	}
	if version != checkFormatVersion {
		return checkstore.Entry{}, fmt.Errorf("cached check answer declares format version %d (want %d)",
			version, checkFormatVersion)
	}

	storedKey, err := stringAttribute(item, attrCacheKey)
	if err != nil {
		return checkstore.Entry{}, err
	}
	if storedKey != key {
		return checkstore.Entry{}, fmt.Errorf("a cached check answer stored under one key was read under another")
	}

	body, err := binaryAttribute(item, attrBody)
	if err != nil {
		return checkstore.Entry{}, err
	}
	if len(body) == 0 {
		return checkstore.Entry{}, fmt.Errorf("a cached check answer has an empty body")
	}
	if len(body) > maxCacheBodyBytes {
		return checkstore.Entry{}, fmt.Errorf("a cached check answer of %d bytes exceeds the %d byte item bound",
			len(body), maxCacheBodyBytes)
	}

	seconds, err := numberAttribute(item, attrExpiresAt)
	if err != nil {
		return checkstore.Entry{}, err
	}
	return checkstore.Entry{Body: body, ExpiresAt: time.Unix(seconds, 0).UTC()}, nil
}

// cacheItemBytes is what one cached answer costs in a request, which is the figure
// maxCacheBodyBytes leaves a margin under. It exists so a test asserts the margin
// rather than a comment claiming it.
func cacheItemBytes(key string, body []byte) int {
	total := len(attrPartition) + len(checkstore.ResultPartition(key))
	total += len(attrSort) + len(checkstore.ResultSort)
	total += len(attrFormatVersion) + 1
	total += len(attrCacheKey) + len(key)
	total += len(attrExpiresAt) + 20
	total += len(attrBody) + base64.StdEncoding.EncodedLen(len(body))
	return total
}
