package dynamo

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// fakeDynamo is a local in-memory stand-in for the DynamoDB API. No test in this
// package reaches AWS, needs credentials, or needs a network.
//
// It implements only what this package sends, and rejects anything else rather than
// approximating it. A fake that silently ignored a condition expression or a
// projection would let a test pass while the real table refused the same write, so
// an unsupported expression is a test failure and not a permissive default.
type fakeDynamo struct {
	mu    sync.Mutex
	table string
	items map[string]map[string]types.AttributeValue

	// pageSize bounds how many items one Query returns, so a test can force the
	// pagination path that a large snapshot takes on a real table.
	pageSize int

	// calls counts operations by name, and putKeys records every key a
	// BatchWriteItem actually stored, in order, so a test can prove that a resumed
	// write touched only the indices that were missing.
	calls   map[string]int
	putKeys []string

	// Hooks run before an operation is applied, and receive the 1-based call
	// number so a test can fail a specific attempt. A nil hook does nothing.
	//
	// A hook runs while the fake holds its lock, which is what lets it model a
	// competing writer landing between a publisher's read and its conditional
	// write. A hook that changes stored state must therefore use the Unlocked
	// helpers; calling a locking method from a hook deadlocks.
	onBatchWrite func(call int, requests []types.WriteRequest) (unprocessed []types.WriteRequest, err error)
	onQuery      func(call int) error
	onGetItem    func(call int) error
	onPutItem    func(call int, item map[string]types.AttributeValue) error
	onUpdateItem func(call int) error
}

func newFake(table string) *fakeDynamo {
	return &fakeDynamo{
		table: table,
		items: make(map[string]map[string]types.AttributeValue),
		calls: make(map[string]int),
	}
}

// newTestStore returns a Store over a fresh fake, with a sleeper that records
// backoff instead of waiting so a bounded-retry test runs at full speed.
func newTestStore(t *testing.T, options Options) (*Store, *fakeDynamo, *[]time.Duration) {
	t.Helper()
	fake := newFake("ens-snapshots")
	var slept []time.Duration
	if options.Table == "" {
		options.Table = fake.table
	}
	if options.Sleep == nil {
		options.Sleep = func(ctx context.Context, delay time.Duration) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			slept = append(slept, delay)
			return nil
		}
	}
	store, err := New(fake, options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return store, fake, &slept
}

// itemKey is the map key of one item, and mirrors the table's composite primary key.
func itemKey(item map[string]types.AttributeValue) (string, error) {
	partition, err := stringAttribute(item, attrPartition)
	if err != nil {
		return "", err
	}
	sort, err := stringAttribute(item, attrSort)
	if err != nil {
		return "", err
	}
	return partition + "\x00" + sort, nil
}

func (f *fakeDynamo) checkTable(name *string) error {
	if name == nil || *name != f.table {
		return fmt.Errorf("fake: request names table %v, want %q", name, f.table)
	}
	return nil
}

// count records a call and returns its 1-based number. The caller holds the lock.
func (f *fakeDynamo) count(operation string) int {
	f.calls[operation]++
	return f.calls[operation]
}

// stored returns a copy of one item, or nil when it is absent.
func (f *fakeDynamo) stored(partition, sort string) map[string]types.AttributeValue {
	f.mu.Lock()
	defer f.mu.Unlock()
	return copyItem(f.items[partition+"\x00"+sort])
}

// put writes an item directly, bypassing every condition, so a test can set up a
// corrupt, mislabelled, or foreign item that this package would never write.
func (f *fakeDynamo) put(item map[string]types.AttributeValue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putUnlocked(item)
}

// putUnlocked is put for a hook, which already runs under the lock.
func (f *fakeDynamo) putUnlocked(item map[string]types.AttributeValue) {
	key, err := itemKey(item)
	if err != nil {
		panic(err)
	}
	f.items[key] = copyItem(item)
}

// corruptChunkUnlocked flips one byte of a stored chunk payload, which is how a
// test models storage returning a chunk that no longer matches its checksum.
func (f *fakeDynamo) corruptChunkUnlocked(partition, sort string) {
	item := f.items[partition+"\x00"+sort]
	if item == nil {
		panic(fmt.Sprintf("fake: no item at %s %s to corrupt", partition, sort))
	}
	payload, ok := item[attrPayload].(*types.AttributeValueMemberB)
	if !ok || len(payload.Value) == 0 {
		panic("fake: item has no payload to corrupt")
	}
	corrupted := append([]byte(nil), payload.Value...)
	corrupted[0] ^= 0xff
	item[attrPayload] = &types.AttributeValueMemberB{Value: corrupted}
}

// keys returns every stored key in sorted order.
func (f *fakeDynamo) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.items))
	for key := range f.items {
		keys = append(keys, strings.Replace(key, "\x00", " ", 1))
	}
	sort.Strings(keys)
	return keys
}

func (f *fakeDynamo) callCount(operation string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[operation]
}

func (f *fakeDynamo) writtenKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.putKeys...)
}

func (f *fakeDynamo) BatchWriteItem(ctx context.Context, params *dynamodb.BatchWriteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	call := f.count("BatchWriteItem")
	requests, ok := params.RequestItems[f.table]
	if !ok || len(params.RequestItems) != 1 {
		return nil, fmt.Errorf("fake: batch write must name only table %q", f.table)
	}
	if len(requests) > maxBatchItems {
		return nil, fmt.Errorf("fake: batch of %d items exceeds the %d item limit", len(requests), maxBatchItems)
	}

	var unprocessed []types.WriteRequest
	if f.onBatchWrite != nil {
		var err error
		unprocessed, err = f.onBatchWrite(call, requests)
		if err != nil {
			return nil, err
		}
	}
	held := make(map[int]bool, len(unprocessed))
	for _, request := range unprocessed {
		for i, candidate := range requests {
			if held[i] {
				continue
			}
			if writeRequestKey(candidate) == writeRequestKey(request) {
				held[i] = true
				break
			}
		}
	}

	for i, request := range requests {
		if held[i] {
			continue
		}
		switch {
		case request.PutRequest != nil:
			key, err := itemKey(request.PutRequest.Item)
			if err != nil {
				return nil, err
			}
			f.items[key] = copyItem(request.PutRequest.Item)
			f.putKeys = append(f.putKeys, strings.Replace(key, "\x00", " ", 1))
		case request.DeleteRequest != nil:
			key, err := itemKey(request.DeleteRequest.Key)
			if err != nil {
				return nil, err
			}
			delete(f.items, key)
		default:
			return nil, fmt.Errorf("fake: write request %d is neither a put nor a delete", i)
		}
	}

	output := &dynamodb.BatchWriteItemOutput{}
	if len(unprocessed) > 0 {
		output.UnprocessedItems = map[string][]types.WriteRequest{f.table: unprocessed}
	}
	return output, nil
}

func (f *fakeDynamo) GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	call := f.count("GetItem")
	if err := f.checkTable(params.TableName); err != nil {
		return nil, err
	}
	// The publisher reads back what it just wrote, so an eventually consistent
	// read would be a correctness bug rather than a performance choice.
	if params.ConsistentRead == nil || !*params.ConsistentRead {
		return nil, fmt.Errorf("fake: GetItem must be strongly consistent")
	}
	if f.onGetItem != nil {
		if err := f.onGetItem(call); err != nil {
			return nil, err
		}
	}
	key, err := itemKey(params.Key)
	if err != nil {
		return nil, err
	}
	return &dynamodb.GetItemOutput{Item: copyItem(f.items[key])}, nil
}

func (f *fakeDynamo) PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	call := f.count("PutItem")
	if err := f.checkTable(params.TableName); err != nil {
		return nil, err
	}
	if f.onPutItem != nil {
		if err := f.onPutItem(call, params.Item); err != nil {
			return nil, err
		}
	}
	key, err := itemKey(params.Item)
	if err != nil {
		return nil, err
	}
	if params.ConditionExpression != nil {
		holds, err := evaluateCondition(*params.ConditionExpression, params.ExpressionAttributeNames,
			params.ExpressionAttributeValues, f.items[key])
		if err != nil {
			return nil, err
		}
		if !holds {
			return nil, &types.ConditionalCheckFailedException{Message: aws.String("the conditional request failed")}
		}
	}
	f.items[key] = copyItem(params.Item)
	return &dynamodb.PutItemOutput{}, nil
}

func (f *fakeDynamo) UpdateItem(ctx context.Context, params *dynamodb.UpdateItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	call := f.count("UpdateItem")
	if err := f.checkTable(params.TableName); err != nil {
		return nil, err
	}
	if f.onUpdateItem != nil {
		if err := f.onUpdateItem(call); err != nil {
			return nil, err
		}
	}
	key, err := itemKey(params.Key)
	if err != nil {
		return nil, err
	}
	existing := f.items[key]
	if params.ConditionExpression != nil {
		holds, err := evaluateCondition(*params.ConditionExpression, params.ExpressionAttributeNames,
			params.ExpressionAttributeValues, existing)
		if err != nil {
			return nil, err
		}
		if !holds {
			return nil, &types.ConditionalCheckFailedException{Message: aws.String("the conditional request failed")}
		}
	}
	// A real UpdateItem creates the item when it does not exist, which is exactly
	// what the attribute_exists guard on the caller's side is there to prevent.
	updated := copyItem(existing)
	if updated == nil {
		updated = copyItem(params.Key)
	}
	if params.UpdateExpression == nil {
		return nil, fmt.Errorf("fake: UpdateItem needs an update expression")
	}
	if err := applyUpdate(*params.UpdateExpression, params.ExpressionAttributeNames,
		params.ExpressionAttributeValues, updated); err != nil {
		return nil, err
	}
	f.items[key] = updated
	return &dynamodb.UpdateItemOutput{}, nil
}

func (f *fakeDynamo) Query(ctx context.Context, params *dynamodb.QueryInput, optFns ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	call := f.count("Query")
	if err := f.checkTable(params.TableName); err != nil {
		return nil, err
	}
	if params.ConsistentRead == nil || !*params.ConsistentRead {
		return nil, fmt.Errorf("fake: Query must be strongly consistent")
	}
	if params.ScanIndexForward == nil || !*params.ScanIndexForward {
		return nil, fmt.Errorf("fake: Query must ask for ascending sort-key order")
	}
	if f.onQuery != nil {
		if err := f.onQuery(call); err != nil {
			return nil, err
		}
	}

	partition, prefix, err := parseKeyCondition(params.KeyConditionExpression,
		params.ExpressionAttributeNames, params.ExpressionAttributeValues)
	if err != nil {
		return nil, err
	}

	var sortKeys []string
	for _, item := range f.items {
		storedPartition, err := stringAttribute(item, attrPartition)
		if err != nil {
			return nil, err
		}
		if storedPartition != partition {
			continue
		}
		storedSort, err := stringAttribute(item, attrSort)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(storedSort, prefix) {
			continue
		}
		sortKeys = append(sortKeys, storedSort)
	}
	sort.Strings(sortKeys)

	if len(params.ExclusiveStartKey) > 0 {
		after, err := stringAttribute(params.ExclusiveStartKey, attrSort)
		if err != nil {
			return nil, err
		}
		for len(sortKeys) > 0 && sortKeys[0] <= after {
			sortKeys = sortKeys[1:]
		}
	}

	pageSize := f.pageSize
	if pageSize <= 0 || pageSize > len(sortKeys) {
		pageSize = len(sortKeys)
	}
	page := sortKeys[:pageSize]

	output := &dynamodb.QueryOutput{}
	for _, key := range page {
		item := copyItem(f.items[partition+"\x00"+key])
		projected, err := project(item, params.ProjectionExpression, params.ExpressionAttributeNames)
		if err != nil {
			return nil, err
		}
		output.Items = append(output.Items, projected)
	}
	if pageSize < len(sortKeys) {
		output.LastEvaluatedKey = map[string]types.AttributeValue{
			attrPartition: stringValue(partition),
			attrSort:      stringValue(page[len(page)-1]),
		}
	}
	return output, nil
}

// parseKeyCondition understands the one key condition this package sends.
func parseKeyCondition(expression *string, names map[string]string, values map[string]types.AttributeValue) (partition, prefix string, err error) {
	if expression == nil {
		return "", "", fmt.Errorf("fake: Query needs a key condition")
	}
	const want = "#pk = :pk AND begins_with(#sk, :prefix)"
	if *expression != want {
		return "", "", fmt.Errorf("fake: unsupported key condition %q, want %q", *expression, want)
	}
	if names["#pk"] != attrPartition || names["#sk"] != attrSort {
		return "", "", fmt.Errorf("fake: key condition names %v do not address the primary key", names)
	}
	partition, err = attributeString(values, ":pk")
	if err != nil {
		return "", "", err
	}
	prefix, err = attributeString(values, ":prefix")
	if err != nil {
		return "", "", err
	}
	return partition, prefix, nil
}

// evaluateCondition understands the four condition forms this package sends.
func evaluateCondition(expression string, names map[string]string, values map[string]types.AttributeValue, item map[string]types.AttributeValue) (bool, error) {
	expression = strings.TrimSpace(expression)
	switch {
	case strings.HasPrefix(expression, "attribute_type(") && strings.HasSuffix(expression, ")"):
		arguments := strings.SplitN(strings.TrimSuffix(strings.TrimPrefix(expression, "attribute_type("), ")"), ",", 2)
		if len(arguments) != 2 {
			return false, fmt.Errorf("fake: attribute_type condition %q needs a path and a type", expression)
		}
		name, err := resolveName(strings.TrimSpace(arguments[0]), names)
		if err != nil {
			return false, err
		}
		want, err := attributeString(values, strings.TrimSpace(arguments[1]))
		if err != nil {
			return false, err
		}
		got, exists := item[name]
		if !exists {
			return false, nil
		}
		return attributeTypeCode(got) == want, nil
	case strings.HasPrefix(expression, "attribute_not_exists(") && strings.HasSuffix(expression, ")"):
		name, err := resolveName(strings.TrimSuffix(strings.TrimPrefix(expression, "attribute_not_exists("), ")"), names)
		if err != nil {
			return false, err
		}
		_, exists := item[name]
		return !exists, nil
	case strings.HasPrefix(expression, "attribute_exists(") && strings.HasSuffix(expression, ")"):
		name, err := resolveName(strings.TrimSuffix(strings.TrimPrefix(expression, "attribute_exists("), ")"), names)
		if err != nil {
			return false, err
		}
		_, exists := item[name]
		return exists, nil
	case strings.Contains(expression, " = "):
		parts := strings.SplitN(expression, " = ", 2)
		name, err := resolveName(strings.TrimSpace(parts[0]), names)
		if err != nil {
			return false, err
		}
		want, exists := values[strings.TrimSpace(parts[1])]
		if !exists {
			return false, fmt.Errorf("fake: condition %q has no binding for %q", expression, parts[1])
		}
		got, exists := item[name]
		if !exists {
			return false, nil
		}
		return attributesEqual(got, want), nil
	default:
		return false, fmt.Errorf("fake: unsupported condition expression %q", expression)
	}
}

// applyUpdate understands a SET expression of comma-separated assignments.
func applyUpdate(expression string, names map[string]string, values map[string]types.AttributeValue, item map[string]types.AttributeValue) error {
	trimmed := strings.TrimSpace(expression)
	if !strings.HasPrefix(trimmed, "SET ") {
		return fmt.Errorf("fake: unsupported update expression %q", expression)
	}
	for _, assignment := range strings.Split(strings.TrimPrefix(trimmed, "SET "), ",") {
		parts := strings.SplitN(assignment, "=", 2)
		if len(parts) != 2 {
			return fmt.Errorf("fake: unsupported assignment %q", assignment)
		}
		name, err := resolveName(strings.TrimSpace(parts[0]), names)
		if err != nil {
			return err
		}
		value, exists := values[strings.TrimSpace(parts[1])]
		if !exists {
			return fmt.Errorf("fake: update has no binding for %q", strings.TrimSpace(parts[1]))
		}
		item[name] = value
	}
	return nil
}

// project keeps only the attributes a projection expression names.
func project(item map[string]types.AttributeValue, expression *string, names map[string]string) (map[string]types.AttributeValue, error) {
	if expression == nil {
		return item, nil
	}
	projected := make(map[string]types.AttributeValue)
	for _, field := range strings.Split(*expression, ",") {
		name, err := resolveName(strings.TrimSpace(field), names)
		if err != nil {
			return nil, err
		}
		if value, exists := item[name]; exists {
			projected[name] = value
		}
	}
	return projected, nil
}

func resolveName(token string, names map[string]string) (string, error) {
	if !strings.HasPrefix(token, "#") {
		return token, nil
	}
	name, exists := names[token]
	if !exists {
		return "", fmt.Errorf("fake: no binding for attribute name %q", token)
	}
	return name, nil
}

func attributeString(values map[string]types.AttributeValue, token string) (string, error) {
	value, exists := values[token]
	if !exists {
		return "", fmt.Errorf("fake: no binding for value %q", token)
	}
	text, ok := value.(*types.AttributeValueMemberS)
	if !ok {
		return "", fmt.Errorf("fake: binding %q is not a string", token)
	}
	return text.Value, nil
}

func attributesEqual(left, right types.AttributeValue) bool {
	switch typed := left.(type) {
	case *types.AttributeValueMemberS:
		other, ok := right.(*types.AttributeValueMemberS)
		return ok && typed.Value == other.Value
	case *types.AttributeValueMemberN:
		other, ok := right.(*types.AttributeValueMemberN)
		return ok && typed.Value == other.Value
	case *types.AttributeValueMemberB:
		other, ok := right.(*types.AttributeValueMemberB)
		if !ok || len(typed.Value) != len(other.Value) {
			return false
		}
		for i := range typed.Value {
			if typed.Value[i] != other.Value[i] {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func copyItem(item map[string]types.AttributeValue) map[string]types.AttributeValue {
	if item == nil {
		return nil
	}
	copied := make(map[string]types.AttributeValue, len(item))
	for name, value := range item {
		if binary, ok := value.(*types.AttributeValueMemberB); ok {
			copied[name] = &types.AttributeValueMemberB{Value: append([]byte(nil), binary.Value...)}
			continue
		}
		copied[name] = value
	}
	return copied
}

// writeRequestKey identifies a write request by the item it addresses, so the fake
// can match the requests a hook held back against the batch it was given.
func writeRequestKey(request types.WriteRequest) string {
	var item map[string]types.AttributeValue
	switch {
	case request.PutRequest != nil:
		item = request.PutRequest.Item
	case request.DeleteRequest != nil:
		item = request.DeleteRequest.Key
	default:
		return ""
	}
	key, err := itemKey(item)
	if err != nil {
		return ""
	}
	return key
}
