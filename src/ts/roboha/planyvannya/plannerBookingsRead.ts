import { supabase } from "../../vxid/supabaseClient";
import { capturePlannerReadVersion, getPlannerReadEpoch, hydratePlannerLabels, rememberPlannerBookings } from "./plannerRecordStore";

const COLUMNS = 'post_arxiv_id,slyusar_id,name_post,client_id,cars_id,status,data_on,data_off,komentar,act_id,xto_zapusav';
export interface PlannerRecord { [key: string]: any; client_data: any; car_data: any }
const pending = new WeakMap<object, Map<string, Promise<PlannerRecord[]>>>();

export function readPlannerBookings(start: string, end: string, staff: number[] | null = null, client = supabase): Promise<PlannerRecord[]> {
  const scope = typeof localStorage === 'undefined' ? '' : localStorage.getItem('userAuthData') || '';
  const ids = staff ? [...new Set(staff)].sort((a,b)=>a-b) : null;
  const key = JSON.stringify([scope,start,end,ids,getPlannerReadEpoch()]);
  let requests = pending.get(client);
  if (!requests) { requests = new Map(); pending.set(client, requests); }
  const existing = requests.get(key);
  if (existing) return existing;
  const readVersion = capturePlannerReadVersion();
  const request = fetchBookings(start,end,ids,client).then(async rows => {
    if (typeof localStorage !== 'undefined' && (localStorage.getItem('userAuthData') || '') !== scope) throw new Error('Контекст користувача змінився');
    const range = {start,end,staff:ids};
    const merged = rememberPlannerBookings(rows, readVersion, range);
    const hydrated = await hydratePlannerLabels(merged, client);
    if (typeof localStorage !== 'undefined' && (localStorage.getItem('userAuthData') || '') !== scope) throw new Error('Контекст користувача змінився');
    return rememberPlannerBookings(hydrated, readVersion, range) as PlannerRecord[];
  });
  requests.set(key,request);
  void request.finally(()=>{ if(requests!.get(key)===request) requests!.delete(key); }).catch(()=>{});
  return request;
}

async function fetchBookings(start: string, end: string, staff: number[] | null, client: typeof supabase): Promise<PlannerRecord[]> {
  const rows: PlannerRecord[] = [];
  for (let offset=0;;offset+=200) {
    const {data,error} = await client.rpc('traffic_planner_bookings',{p_start:start,p_end:end,p_staff:staff,p_offset:offset});
    if (error) {
      if (offset===0 && ['PGRST202','42883'].includes(error.code)) return legacyBookings(start,end,staff,client);
      throw error;
    }
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw new Error('Некоректна відповідь планування');
    rows.push(...data.items);
    if (!data.has_more) return rows;
    if(data.items.length!==200) throw new Error('Неповна сторінка планування');
  }
}

async function legacyBookings(start: string,end: string,staff: number[] | null,client: typeof supabase): Promise<PlannerRecord[]> {
  let query=client.from('post_arxiv').select(COLUMNS).gte('data_on',start).lte('data_on',end);
  if(staff) query=query.in('slyusar_id',staff);
  const {data,error}=await query;
  if(error) throw error;
  return hydratePlannerLabels(data || [], client) as Promise<PlannerRecord[]>;
}
