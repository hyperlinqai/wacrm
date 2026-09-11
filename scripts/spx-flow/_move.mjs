import fs from 'node:fs'
import { connect } from './lib.mjs'
const DRY = process.argv.includes('--dry-run')
const c = connect(); await c.connect(); await c.query('SET ROLE service_role')
const q = async (s,p=[]) => (await c.query(s,p)).rows
const A='3463fcc5-bcc5-42dd-99bb-22a93d9d43d1', CUT='2026-08-01T00:00:00+05:30'
const LEAD_TAGS=['Meta Lead Ad','Stage 01 · New Lead']
console.table(await q(`select name, trigger_type, is_active from automations where account_id=$1 and trigger_type ilike '%tag_removed%'`,[A]).catch(e=>[{err:e.message}]))
await q('BEGIN')
try {
  const bf = await c.query(fs.readFileSync('scripts/backfill-meta-lead-created-at.sql','utf8'))
  console.log('backfill updated', bf.rowCount)
  const before = (await q(`select count(*) n from contacts where account_id=$1 and created_at >= $2`,[A,CUT]))[0].n
  const ids = (await q(`select id from contacts where account_id=$1 and created_at < $2`,[A,CUT])).map(r=>r.id)
  console.log('pre-Aug contacts', ids.length, '| on/after Aug', before)
  const [{user_id}] = await q(`select user_id from contact_lists where account_id=$1 limit 1`,[A])
  const [list] = await q(`insert into contact_lists(account_id,user_id,name,description,color)
     values($1,$2,'Pre-Aug 2026 Leads','Contacts whose Meta lead predates 1 Aug 2026 (moved out of the lead tags on 2026-09-11)','#64748b')
     on conflict (organization_id, lower(name)) do update set updated_at=now() returning id`,[A,user_id])
  const ins = await c.query(`insert into contact_list_members(list_id,contact_id) select $1, unnest($2::uuid[]) on conflict do nothing`,[list.id, ids])
  console.log('list', list.id, 'members added', ins.rowCount)
  const removed = await q(`delete from contact_tags ct using tags t where t.id=ct.tag_id and t.account_id=$1 and t.name = any($2) and ct.contact_id = any($3) returning ct.*, t.name tag_name`,[A,LEAD_TAGS,ids])
  fs.writeFileSync(process.env.S+'/removed-contact-tags.json', JSON.stringify(removed,null,1))
  console.log('lead tag rows removed', removed.length, removed.reduce((m,r)=>(m[r.tag_name]=(m[r.tag_name]||0)+1,m),{}))
  const after = (await q(`select count(*) n from contacts where account_id=$1 and created_at >= $2`,[A,CUT]))[0].n
  const total = (await q(`select count(*) n from contacts where account_id=$1`,[A]))[0].n
  console.log('on/after Aug still', after, '| total contacts', total)
  await q(DRY ? 'ROLLBACK' : 'COMMIT'); console.log(DRY ? 'ROLLED BACK (dry run)' : 'COMMITTED')
} catch (e) { await q('ROLLBACK'); throw e }
await c.end()
