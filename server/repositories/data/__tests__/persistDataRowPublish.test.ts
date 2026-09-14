import { describe, expect, it, beforeEach } from 'bun:test'
import { nanoid } from 'nanoid'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { createUser } from '../../users'
import { persistDataRowPublish } from '../publish'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

async function sleepPastTimestampResolution(): Promise<void> {
  // sqlite's current_timestamp / strftime('%s','now') has 1-second
  // resolution — without this, a first-publish-then-republish pair in the
  // same test can land on the same wall-clock second even with a real bug
  // present, masking the regression this test exists to catch.
  await new Promise((resolve) => setTimeout(resolve, 1100))
}

describe('persistDataRowPublish — published_at semantics', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('stamps published_at on the first publish', async () => {
    const publisher = await createUser(db, {
      email: 'publisher@example.com',
      displayName: 'Percy Publisher',
      passwordHash: 'h-publisher',
      roleId: 'admin',
    })
    const rowId = nanoid()
    await db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values (${rowId}, ${'posts'}, ${'{}'}, ${'first-post'}, ${'draft'})
    `

    const result = await persistDataRowPublish(db, rowId, publisher.id)

    expect(result.row.publishedAt).not.toBeNull()
    expect(result.version.publishedAt).toBe(result.row.publishedAt as string)
  })

  it('regression: preserves published_at across a republish instead of resetting it to now', async () => {
    const publisher = await createUser(db, {
      email: 'publisher2@example.com',
      displayName: 'Percy Publisher',
      passwordHash: 'h-publisher',
      roleId: 'admin',
    })
    const rowId = nanoid()
    await db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values (${rowId}, ${'posts'}, ${'{}'}, ${'existing-post'}, ${'draft'})
    `

    const firstPublish = await persistDataRowPublish(db, rowId, publisher.id)
    const originalPublishedAt = firstPublish.row.publishedAt
    expect(originalPublishedAt).not.toBeNull()

    await sleepPastTimestampResolution()

    // Simulate an edit + republish (e.g. an SEO-field tweak that requires
    // rebaking the static artefact) — this must NOT be indistinguishable
    // from a first publish.
    const republish = await persistDataRowPublish(db, rowId, publisher.id)

    expect(republish.row.publishedAt).toBe(originalPublishedAt)
    expect(republish.version.publishedAt).toBe(originalPublishedAt as string)
    // updated_at is expected to move — only published_at must be pinned.
    expect(republish.row.updatedAt).not.toBe(firstPublish.row.updatedAt)
  })

  it('regression: two rows republished in different order stay in their original relative order', async () => {
    // Direct reproduction of the 2026-09-13 blog-index bug: two
    // already-published rows, republished in reverse of their original
    // publish order (e.g. because one needed a metadata fix and the other
    // didn't), must NOT swap places in a `published_at desc` sort.
    const publisher = await createUser(db, {
      email: 'publisher3@example.com',
      displayName: 'Percy Publisher',
      passwordHash: 'h-publisher',
      roleId: 'admin',
    })
    const olderRowId = nanoid()
    const newerRowId = nanoid()
    await db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values (${olderRowId}, ${'posts'}, ${'{}'}, ${'older-post'}, ${'draft'})
    `
    const olderFirstPublish = await persistDataRowPublish(db, olderRowId, publisher.id)

    await sleepPastTimestampResolution()

    await db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values (${newerRowId}, ${'posts'}, ${'{}'}, ${'newer-post'}, ${'draft'})
    `
    const newerFirstPublish = await persistDataRowPublish(db, newerRowId, publisher.id)

    expect(newerFirstPublish.row.publishedAt! > olderFirstPublish.row.publishedAt!).toBe(true)

    await sleepPastTimestampResolution()

    // Republish the OLDER row last — a naive `published_at = now()` would
    // put it ahead of the newer row in the index.
    const olderRepublish = await persistDataRowPublish(db, olderRowId, publisher.id)

    expect(olderRepublish.row.publishedAt).toBe(olderFirstPublish.row.publishedAt)
    expect(olderRepublish.row.publishedAt! < newerFirstPublish.row.publishedAt!).toBe(true)
  })
})
