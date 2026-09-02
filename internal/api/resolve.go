package api

import (
	"context"
	"errors"
	"reflect"

	"ens-scrape/internal/snapshot"
)

// cachedSnapshot is one verified snapshot, ready to serve.
//
// latest is the whole pointer the snapshot was verified against, and it is what
// decides whether this entry may still be used. body is the published canonical
// JSON; meta is the encoded summary document. Both are immutable once stored, so
// a response never has to re-verify, re-serialize, or re-encode anything.
type cachedSnapshot struct {
	latest snapshot.Latest
	body   []byte
	meta   []byte
	etag   string
}

// resolve returns the snapshot the latest pointer names, verified end to end, or
// the failure that stopped it.
//
// The steps are the ones snapshot.Read performs, in the same order, run one at a
// time so an HTTP status can name which one failed: an absent pointer is a store
// with nothing published, absent chunks are a published snapshot that vanished,
// and a payload that does not verify is corruption. snapshot.Read stays the
// one-call path for a publisher, which needs the outcome and not the step.
//
// Nothing is ever repaired or partially served. Every failure returns no body.
func (h *Handler) resolve(ctx context.Context) (*cachedSnapshot, *failure) {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	latest, err := h.config.Store.GetLatest(ctx)
	if err != nil {
		switch {
		case contextFailed(ctx, err):
			return nil, failed(failureUnavailable)
		case errors.Is(err, snapshot.ErrNotFound):
			return nil, failed(failureNoSnapshot)
		default:
			// A pointer that does not read could be corrupt or the store could be
			// failing, and this side of the call cannot tell which, so the code says
			// only what is known: there is no snapshot to serve right now.
			return nil, failed(failureUnavailable)
		}
	}

	// The declared raw size is checked before a single chunk is fetched, so an
	// oversized snapshot bounds the work and not just the response. Verify proves
	// the declaration against the bytes, so acting on it here is sound.
	if latest.RawBytes > h.config.MaxBodyBytes {
		return nil, failed(failureTooLarge)
	}

	if h.cached != nil && reflect.DeepEqual(h.cached.latest, latest) {
		return h.cached, nil
	}

	chunks, err := h.config.Store.GetChunks(ctx, latest.SnapshotID)
	if err != nil {
		switch {
		case contextFailed(ctx, err):
			return nil, failed(failureUnavailable)
		case errors.Is(err, snapshot.ErrNotFound):
			// The pointer resolved and its chunks are gone. That is a published
			// snapshot that disappeared rather than a store with nothing in it, and
			// the contract keeps the two apart for the same reason this does.
			return nil, failed(failureChunksMissing)
		default:
			return nil, failed(failureUnavailable)
		}
	}

	// Verify is the only judge of the payload: chunk count, chunk identity, order,
	// every checksum, canonical form, and agreement with the pointer's summary. A
	// chunk relabelled from another snapshot, or a set mixed across a publication,
	// fails here rather than reaching a client.
	verified, err := snapshot.Verify(latest, chunks)
	if err != nil {
		return nil, failed(failureUnreadable)
	}

	// EncodeJSON reproduces the canonical bytes Verify already proved the stored
	// payload to be, so the body is the published snapshot and not a re-rendering
	// of it, and its SHA-256 is latest.Checksum. That also makes the bound checked
	// against the pointer above a bound on this body, with no second reading of
	// MaxBodyBytes needed.
	//
	// The length is still compared rather than assumed. It is the one cheap check
	// that ties the bytes about to be served to the checksum the response
	// advertises, and serving a body that disagreed with the pointer would hand a
	// client something its own verification must reject.
	body, err := snapshot.EncodeJSON(verified)
	if err != nil {
		return nil, failed(failureUnreadable)
	}
	if len(body) != latest.RawBytes {
		return nil, failed(failureUnreadable)
	}

	meta, err := encodeMeta(verified.Metadata, latest)
	if err != nil {
		return nil, failed(failureUnreadable)
	}

	h.cached = &cachedSnapshot{
		latest: latest,
		body:   body,
		meta:   meta,
		etag:   entityTag(latest.SnapshotID),
	}
	return h.cached, nil
}

// contextFailed reports whether a read failed because the request went away.
// A cancelled or expired context says nothing about what is stored, so it must
// never be read as an empty store or as corruption.
func contextFailed(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
