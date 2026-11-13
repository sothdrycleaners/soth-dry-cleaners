import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Pencil, Search, Send, Undo2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import api from '@/lib/api';

type Contact = {
  id: number;
  full_name: string;
  role: string;
  branch_name?: string | null;
  last_login?: string | null;
  unread_count: number;
  last_message?: string | null;
};
type ChatMessage = {
  id: number;
  sender_id: number;
  recipient_id: number;
  sender_name: string;
  sender_role: string;
  sender_context?: string;
  sender_branch_name?: string | null;
  message: string;
  created_at: string;
  read_at?: string | null;
  edited_at?: string | null;
  unsent_at?: string | null;
};
const timeLabel = (value: string) => new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const loginLabel = (value?: string | null) => value
  ? 'Last login ' + new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  : 'Has not signed in yet';

export default function TeamMessagesPanel({ operationsWorkspace = false }: { operationsWorkspace?: boolean }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [conversationPeerId, setConversationPeerId] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [draft, setDraft] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactBranch, setContactBranch] = useState('all');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const peerId = Number(params.get('peer')) || 0;

  const loadContacts = useCallback(async () => {
    try {
      const response = await api.get('/operations/contacts');
      setContacts(response.data.contacts || []);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Unable to load staff contacts');
    }
  }, []);

  const loadConversation = useCallback(async () => {
    if (!peerId) {
      setMessages([]);
      setHasOlder(false);
      setConversationPeerId(0);
      return;
    }
    try {
      const response = await api.get('/operations/conversations/' + peerId);
      const incoming: ChatMessage[] = response.data.messages || [];
      setMessages((current) => {
        if (conversationPeerId !== peerId) return incoming;
        const byId = new Map([...current, ...incoming].map((message) => [message.id, message]));
        return [...byId.values()].sort((a, b) => a.id - b.id);
      });
      setConversationPeerId(peerId);
      setHasOlder(Boolean(response.data.has_older));
      void loadContacts();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Unable to load this conversation');
    }
  }, [peerId, loadContacts, conversationPeerId]);

  useEffect(() => {
    void loadContacts();
    const timer = window.setInterval(() => void loadContacts(), 20000);
    return () => window.clearInterval(timer);
  }, [loadContacts]);

  useEffect(() => {
    if (!peerId && contacts.length) {
      const next = new URLSearchParams(params);
      next.set('peer', String(contacts[0].id));
      setParams(next, { replace: true });
    }
  }, [contacts, peerId, params, setParams]);

  useEffect(() => {
    void loadConversation();
    const timer = window.setInterval(() => void loadConversation(), 8000);
    return () => window.clearInterval(timer);
  }, [loadConversation]);

  const branches = useMemo(
    () => [...new Set(contacts.map((contact) => contact.branch_name).filter(Boolean))] as string[],
    [contacts]
  );
  const visibleContacts = useMemo(() => contacts.filter((contact) => {
    const nameMatch = (contact.full_name + ' ' + contact.role + ' ' + (contact.branch_name || ''))
      .toLowerCase().includes(contactSearch.toLowerCase());
    const branchMatch = contactBranch === 'all' || contact.branch_name === contactBranch;
    return nameMatch && branchMatch;
  }), [contacts, contactSearch, contactBranch]);

  const selectContact = (id: number) => {
    const next = new URLSearchParams(params);
    next.set('peer', String(id));
    setParams(next);
  };

  const loadOlder = async () => {
    if (!peerId || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await api.get('/operations/conversations/' + peerId + '?before=' + messages[0].id);
      const older: ChatMessage[] = response.data.messages || [];
      setMessages((current) => {
        const byId = new Map([...older, ...current].map((message) => [message.id, message]));
        return [...byId.values()].sort((a, b) => a.id - b.id);
      });
      setHasOlder(Boolean(response.data.has_older));
    } catch (e: any) {
      setError(e.response?.data?.error || 'Unable to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !peerId) return;
    setSending(true);
    setError('');
    try {
      await api.post('/operations/direct-messages', { recipient_id: peerId, message: draft.trim(), sender_context: operationsWorkspace ? 'OPERATIONS' : 'STAFF' });
      setDraft('');
      await loadConversation();
      await loadContacts();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Message could not be sent');
    } finally {
      setSending(false);
    }
  };

  const saveEditedMessage = async () => {
    if (!editingMessageId || !editDraft.trim()) return;
    setSavingEdit(true);
    try {
      await api.patch('/operations/direct-messages/' + editingMessageId, { message: editDraft.trim() });
      setEditingMessageId(null);
      setEditDraft('');
      await loadConversation();
      await loadContacts();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Unable to edit message');
    } finally {
      setSavingEdit(false);
    }
  };

  const unsendMessage = async (messageId: number) => {
    if (!window.confirm('Unsend this message for everyone in the conversation?')) return;
    try {
      await api.delete('/operations/direct-messages/' + messageId);
      await loadConversation();
      await loadContacts();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Unable to unsend message');
    }
  };

  const peer = contacts.find((contact) => contact.id === peerId);
  const mergeKey = peerId;

  return (
    <div className="grid min-h-[520px] overflow-hidden rounded-2xl border bg-card md:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-b p-3 md:border-b-0 md:border-r">
        <div className="mb-3 flex items-center gap-2 px-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">Staff inbox</h2>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs">{contacts.length}</span>
        </div>
        <div className="mb-2 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Find staff" className="h-9 w-full rounded-lg border bg-background pl-8 pr-2 text-sm" />
          </div>
          {branches.length > 0 && (
            <select aria-label="Filter staff by branch" value={contactBranch} onChange={(event) => setContactBranch(event.target.value)} className="h-9 max-w-36 rounded-lg border bg-background px-2 text-xs">
              <option value="all">All branches</option>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          )}
        </div>
        <div className="max-h-[260px] space-y-1 overflow-y-auto md:max-h-[600px]">
          {visibleContacts.map((contact) => (
            <button key={contact.id} onClick={() => selectContact(contact.id)} className={'flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors ' + (peerId === contact.id ? 'bg-primary/10' : 'hover:bg-muted')}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted"><UserRound className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <b className="truncate text-sm">{contact.full_name}</b>
                  {contact.unread_count > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{contact.unread_count}</span>}
                </span>
                <small className="block truncate text-muted-foreground">{contact.role.replace('_', ' ')}{contact.branch_name ? ' · ' + contact.branch_name : ''}</small>
                <small className="block truncate text-muted-foreground">{loginLabel(contact.last_login)}</small>
                {contact.last_message && <small className="block truncate text-muted-foreground">{contact.last_message}</small>}
              </span>
            </button>
          ))}
          {!visibleContacts.length && <p className="p-3 text-sm text-muted-foreground">No active staff match that search.</p>}
        </div>
      </aside>
      <section className="flex min-h-[500px] min-w-0 flex-col">
        <header className="border-b p-4">
          <h3 className="font-semibold">{peer?.full_name || 'Choose a staff member'}</h3>
          <p className="text-xs text-muted-foreground">{peer ? [peer.role.replace('_', ' '), peer.branch_name, loginLabel(peer.last_login)].filter(Boolean).join(' · ') : 'Operations and desktop team conversations'}</p>
        </header>
        {error && <p role="alert" className="m-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
        <div key={mergeKey} className="flex-1 space-y-3 overflow-y-auto p-4">
          {hasOlder && <div className="text-center"><button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted">{loadingOlder ? 'Loading older messages...' : 'Load older messages'}</button></div>}
          {messages.map((message) => {
            const ownMessage = Number(message.sender_id) === Number(user?.id);
            const fromOperations = message.sender_role === 'OPERATIONS' || message.sender_context === 'OPERATIONS';
            const displayName = !ownMessage && user?.role === 'DESKTOP_AGENT' && fromOperations ? 'Operations' : message.sender_name;
            return (
              <div key={message.id} className={'max-w-[88%] rounded-2xl px-3 py-2 ' + (ownMessage ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted')}>
                <div className="mb-1 flex items-center justify-between gap-4"><b className="text-xs">{ownMessage && operationsWorkspace ? 'You (Operations)' : displayName}</b><time className="text-[10px] opacity-70">{timeLabel(message.created_at)}</time></div>
                {!ownMessage && <small className="mb-1 block text-[10px] opacity-70">{message.sender_role.replace('_', ' ')}{message.sender_branch_name ? ' | ' + message.sender_branch_name : ''}</small>}
                {editingMessageId === message.id ? (
                  <div className="space-y-2">
                    <textarea value={editDraft} onChange={(event) => setEditDraft(event.target.value)} maxLength={2000} rows={3} className="w-full rounded-lg border bg-background p-2 text-sm text-foreground" />
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditingMessageId(null)}>Cancel</Button>
                      <Button type="button" size="sm" disabled={!editDraft.trim() || savingEdit} onClick={() => void saveEditedMessage()}>{savingEdit ? 'Saving...' : 'Save edit'}</Button>
                    </div>
                  </div>
                ) : <p className={'whitespace-pre-wrap break-words text-sm ' + (message.unsent_at ? 'italic opacity-75' : '')}>{message.unsent_at ? 'This message was unsent.' : message.message}{message.edited_at && !message.unsent_at ? <small className="ml-2 text-[10px] opacity-70">(edited)</small> : null}</p>}
                {ownMessage && !message.unsent_at && Date.now() - new Date(message.created_at).getTime() <= 5 * 60 * 1000 && editingMessageId !== message.id && <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => { setEditingMessageId(message.id); setEditDraft(message.message); }} className="inline-flex items-center gap-1 text-[10px] opacity-75 hover:opacity-100"><Pencil className="h-3 w-3" /> Edit</button><button type="button" onClick={() => void unsendMessage(message.id)} className="inline-flex items-center gap-1 text-[10px] opacity-75 hover:opacity-100"><Undo2 className="h-3 w-3" /> Unsend</button></div>}
                {ownMessage && <small className="mt-1 block text-right text-[10px] opacity-70">{message.read_at ? 'Read' : 'Sent'}</small>}
              </div>
            );
          })}
          {peerId && !messages.length && <p className="py-8 text-center text-sm text-muted-foreground">This conversation is ready. Send a message to begin.</p>}
        </div>
        <form onSubmit={send} className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} rows={2} disabled={!peerId || sending} placeholder={peerId ? 'Write a message to ' + (peer?.full_name || 'staff member') : 'Choose a staff member'} className="min-h-12 flex-1 resize-y rounded-xl border bg-background p-3 text-sm" />
            <Button type="submit" disabled={!draft.trim() || !peerId || sending} aria-label="Send staff message"><Send className="h-4 w-4" /></Button>
          </div>
          <div className="mt-1 text-right text-xs text-muted-foreground">{draft.length.toLocaleString()} / 2,000 characters</div>
        </form>
      </section>
    </div>
  );
}
