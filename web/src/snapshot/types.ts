import type { Cadence, Status } from './contract'

/**
 * The wire shapes, exactly as `internal/snapshot` serializes them. Documents are
 * kept in this form for caching, so what is stored is what was validated, and a
 * view model is derived from them separately.
 */

export interface SourceListDocument {
  readonly id: string
  readonly path: string
  readonly cadence: Cadence
  readonly names: number
}

export interface ScanAgeDocument {
  readonly expected_interval_seconds: number
  readonly stale_after_seconds: number
}

export interface MetadataDocument {
  readonly format_version: number
  readonly snapshot_id: string
  readonly scanned_at: string
  readonly sources: readonly SourceListDocument[]
  readonly scan_age: ScanAgeDocument
  readonly names: number
  readonly counts: Readonly<Record<Status, number>>
}

export interface ResultDocument {
  readonly name: string
  readonly status: Status
  readonly expiry?: string
  readonly grace_ends?: string
  readonly premium_ends?: string
}

export interface SnapshotDocument {
  readonly metadata: MetadataDocument
  readonly results: readonly ResultDocument[]
}

/**
 * The latest pointer, `META/LATEST`. The website treats it as optional extra
 * detail: the snapshot metadata already carries everything needed to browse, and
 * the pointer only adds the publication time and the integrity summary.
 */
export interface LatestDocument {
  readonly format_version: number
  readonly snapshot_id: string
  readonly scanned_at: string
  readonly published_at: string
  readonly checksum: string
  readonly compressed_checksum: string
  readonly raw_bytes: number
  readonly compressed_bytes: number
  readonly chunk_count: number
  readonly names: number
  readonly counts: Readonly<Record<Status, number>>
  readonly sources: readonly SourceListDocument[]
  readonly scan_age: ScanAgeDocument
}

/** A source list, with its parsed cadence. */
export interface SourceList {
  readonly id: string
  readonly path: string
  readonly cadence: Cadence
  readonly names: number
}

/** One lifecycle result, with timestamps parsed and the bare label extracted. */
export interface SnapshotResult {
  readonly name: string
  readonly label: string
  readonly status: Status
  readonly expiry: Date | null
  readonly graceEnds: Date | null
  readonly premiumEnds: Date | null
}

/** Snapshot metadata, with timestamps parsed. */
export interface SnapshotMetadata {
  readonly snapshotId: string
  readonly scannedAt: Date
  readonly sources: readonly SourceList[]
  readonly expectedIntervalSeconds: number
  readonly staleAfterSeconds: number
  readonly names: number
  readonly counts: Readonly<Record<Status, number>>
}

/** The browse-ready view of one published scan. */
export interface Snapshot {
  readonly metadata: SnapshotMetadata
  readonly results: readonly SnapshotResult[]
  /** Publication time, when the latest pointer was available. */
  readonly publishedAt: Date | null
}
