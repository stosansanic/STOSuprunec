const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');

test('initial fifty then five-row pages preserve totals, ordering, remainder and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon;create role authenticated;create table cars(cars_id bigint,client_id bigint,data jsonb,is_deleted boolean);create table clients(client_id bigint,data jsonb);create table acts(act_id bigint primary key,client_id bigint,cars_id bigint,date_on timestamptz,date_off timestamptz,data jsonb,pruimalnyk text,"slusarsOn" boolean);create table act_changes_notifications(act_id bigint,delit boolean,pruimalnyk text)');
    for (const name of ['20261005100000_traffic_service_book.sql','20261005110000_traffic_act_read_models.sql','20261011040000_traffic_act_search.sql','20261011121131_traffic_act_infinite_scroll.sql']) {
      await db.exec(fs.readFileSync('supabase/migrations/' + name, 'utf8'));
    }
    await db.exec("insert into acts(act_id,date_on,data) select n,'2026-10-11','{}' from generate_series(1,62) n");
    const read = async (offset, size) => (await db.query("select traffic_act_search_page_v2(null,null,'open','[]',$1,'id',$2) v", [offset,size])).rows[0].v;
    const ids = [];
    for (const [offset,size,length,next] of [[0,50,50,50],[50,5,5,55],[55,5,5,60],[60,5,2,null]]) {
      const page = await read(offset,size);
      assert.equal(page.items.length,length);assert.equal(page.matched,62);assert.equal(page.next_offset,next);
      ids.push(...page.items.map(a=>a.act_id));
    }
    assert.deepEqual(ids,Array.from({length:62},(_,i)=>62-i));
    assert.equal((await read(62,5)).has_more,false);
    await assert.rejects(read(0,500),/Invalid page size/);
    await db.exec('grant select on acts,clients,cars to authenticated;alter table acts enable row level security;create policy only_two on acts for select to authenticated using(act_id<=2);set role authenticated');
    const restricted = await read(0,5);
    assert.equal(restricted.matched,2);assert.deepEqual(restricted.items.map(a=>a.act_id),[2,1]);
  } finally { await db.close(); }
});
