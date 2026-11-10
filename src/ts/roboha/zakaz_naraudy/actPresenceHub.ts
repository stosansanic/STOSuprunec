import { supabase } from "../../vxid/supabaseClient";

type EditorPresence = { actId: number; userName: string; openedAt: string };
type Observer = (state: Record<string, any[]>) => void;

/** A topic has one channel per client. Table observers and the editor share it. */
export function createActPresenceHub(client: any) {
  const observers = new Set<Observer>();
  let channel: any = null;
  let subscribed = false;
  let suspended = false;
  let editor: EditorPresence | null = null;
  let published: EditorPresence | null = null;
  let generation = 0;
  let writes = Promise.resolve();

  const disconnect = () => {
    const previous = channel;
    channel = null; subscribed = false; published = null; generation++;
    if (previous) void client.removeChannel(previous);
  };
  const publish = () => {
    const current = channel, version = generation;
    writes = writes.catch(() => {}).then(async () => {
      if (!current || current !== channel || version !== generation || !subscribed) return;
      const next = editor;
      if (next === published) return;
      if (next) await current.track(next);
      else await current.untrack();
      if (current === channel && version === generation) published = next;
    });
    return writes;
  };
  const connect = () => {
    if (channel || suspended || (!observers.size && !editor)) return;
    const version = ++generation;
    const current = client.channel("global_acts_presence", { config: { presence: { key: "" } } });
    channel = current;
    current.on("presence", { event: "sync" }, () => {
      if (current !== channel || version !== generation) return;
      const state = current.presenceState();
      for (const observer of [...observers]) { try { observer(state); } catch { /* Keep other observers active. */ } }
    }).subscribe((status: string) => {
      if (current !== channel || version !== generation) return;
      subscribed = status === "SUBSCRIBED";
      if (subscribed) { published = null; void publish().catch(() => {}); }
    });
  };

  return {
    observe(observer: Observer) {
      observers.add(observer); connect();
      if (subscribed && channel) observer(channel.presenceState());
      let released = false;
      return () => {
        if (released) return;
        released = true; observers.delete(observer);
        if (!observers.size && !editor) disconnect();
      };
    },
    async setEditor(actId: number, userName: string): Promise<void> {
      if (editor?.actId === actId && editor.userName === userName) return;
      editor = { actId, userName, openedAt: new Date().toISOString() };
      connect();
      await publish();
    },
    async clearEditor(): Promise<void> {
      editor = null;
      await publish().catch(() => {});
      if (!observers.size && !editor) disconnect();
    },
    suspend() { suspended = true; disconnect(); },
    resume() { suspended = false; connect(); },
  };
}

export const actPresenceHub = createActPresenceHub(supabase);
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => actPresenceHub.suspend());
  window.addEventListener("pageshow", event => { if (event.persisted) actPresenceHub.resume(); });
}
