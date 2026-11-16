const identifier = value => `"${value.replaceAll('"', '""')}"`;

export async function snapshotDatabase(client) {
  const sql = await client.reserve();
  const tables = await sql`select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
    order by n.nspname, c.relname`;
  for (const [index, table] of tables.entries()) {
    table.source = `${identifier(table.schema)}.${identifier(table.name)}`;
    table.copy = `pg_temp.${identifier(`roo_case_${index}`)}`;
    const columns = await sql`select a.attname as name from pg_attribute a
      where a.attrelid = ${`${table.schema}.${table.name}`}::regclass
        and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' order by a.attnum`;
    table.columns = columns.map(column => identifier(column.name)).join(', ');
    await sql.unsafe(`create temporary table ${table.copy} as select ${table.columns} from ${table.source}`);
  }
  const sequences = await sql`select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'`;
  for (const sequence of sequences) {
    sequence.source = `${identifier(sequence.schema)}.${identifier(sequence.name)}`;
    [sequence.value] = await sql.unsafe(`select last_value, is_called from ${sequence.source}`);
  }
  return {
    async cancelPending() {
      await sql`select pg_cancel_backend(pid) from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and backend_type = 'client backend' and state <> 'idle'`;
    },
    async restore() {
      await sql`begin`;
      try {
        await sql`set local session_replication_role = replica`;
        for (const table of tables) await sql.unsafe(`delete from ${table.source}`);
        for (const table of tables) await sql.unsafe(`insert into ${table.source} (${table.columns}) overriding system value select ${table.columns} from ${table.copy}`);
        for (const sequence of sequences) await sql`select setval(${sequence.source}::regclass, ${sequence.value.last_value}, ${sequence.value.is_called})`;
        await sql`commit`;
      } catch (error) {
        await sql`rollback`;
        throw error;
      }
    },
    async differences() {
      const changed = [];
      for (const table of tables) {
        const [result] = await sql.unsafe(`select exists (
          (select to_jsonb(t) from (select ${table.columns} from ${table.source}) t except all select to_jsonb(s) from (select ${table.columns} from ${table.copy}) s)
          union all
          (select to_jsonb(s) from (select ${table.columns} from ${table.copy}) s except all select to_jsonb(t) from (select ${table.columns} from ${table.source}) t)
        ) as changed`);
        if (result.changed) changed.push(`${table.schema}.${table.name}`);
      }
      for (const sequence of sequences) {
        const [value] = await sql.unsafe(`select last_value, is_called from ${sequence.source}`);
        if (String(value.last_value) !== String(sequence.value.last_value) || value.is_called !== sequence.value.is_called) changed.push(`${sequence.schema}.${sequence.name}`);
      }
      return changed;
    },
    release() { sql.release(); },
  };
}
