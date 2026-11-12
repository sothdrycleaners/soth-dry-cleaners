import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  Check, CheckCircle2,
  ChevronDown, ChevronRight, Download, FileText,
  MessageCircle, PackageCheck, Plus, Search, Send, Sparkles, WashingMachine,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { MainLayout } from '@/components/layout/MainLayout';
import './OperationsDemo.css';

const localDateKey = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};
const today = localDateKey();
const relativeDate = (daysAgo: number) => { const date = new Date(); date.setDate(date.getDate() - daysAgo); return localDateKey(date); };

type ItemStatus = 'RECEIVED' | 'PROCESSING' | 'READY';
type WorkItem = {
  id: string;
  name: string;
  quantity: number;
  status: ItemStatus;
  note: string;
  readyAt?: string;
  readyAtTime?: string;
};
type WorkOrder = {
  id: string;
  orderNumber: string;
  customer: string;
  customerNumber: string;
  branch: string;
  recordedBy: string;
  receivedAt: string;
  receivedDate: string;
  dueAt: string;
  express: boolean;
  agentNote?: string;
  items: WorkItem[];
};
type DemoMessage = {
  id: string;
  branch: string;
  orderNumber: string;
  sender: string;
  message: string;
  time: string;
  outgoing: boolean;
};
type AppPage = 'dashboard' | 'queue' | 'reports' | 'messages' | 'delivered';
type QueueStatus = 'ALL' | 'EXPRESS' | ItemStatus;

const initialOrders: WorkOrder[] = [
  {
    id: 'ord-10482', orderNumber: 'SO-10482', customer: 'Miriam N.', customerNumber: 'CUS-20418', branch: 'Ntinda Branch', recordedBy: 'Sarah K.',
    receivedAt: '2:18 PM', receivedDate: today, dueAt: '3:45 PM', express: true,
    agentNote: 'Customer is waiting nearby. Please prioritize this order and update the desk when it is ready.',
    items: [
      { id: '10482-1', name: 'Business shirt', quantity: 3, status: 'RECEIVED', note: '' },
      { id: '10482-2', name: 'Silk dress', quantity: 1, status: 'RECEIVED', note: 'Check the care label before cleaning.' },
    ],
  },
  {
    id: 'ord-10479', orderNumber: 'SO-10479', customer: 'Amina K.', customerNumber: 'CUS-20377', branch: 'Kololo Branch', recordedBy: 'James M.',
    receivedAt: '1:52 PM', receivedDate: today, dueAt: '6:00 PM', express: false,
    agentNote: 'Customer will collect from the Kololo branch.',
    items: [
      { id: '10479-1', name: 'Duvet cover', quantity: 1, status: 'PROCESSING', note: 'White with a blue border.' },
      { id: '10479-2', name: 'Pillow covers', quantity: 4, status: 'RECEIVED', note: '' },
    ],
  },
  {
    id: 'ord-10476', orderNumber: 'SO-10476', customer: 'Peter S.', customerNumber: 'CUS-20162', branch: 'Ntinda Branch', recordedBy: 'Sarah K.',
    receivedAt: '1:25 PM', receivedDate: today, dueAt: '5:30 PM', express: false,
    items: [
      { id: '10476-1', name: 'Trousers', quantity: 2, status: 'READY', note: '', readyAt: today, readyAtTime: '1:35 PM' },
      { id: '10476-2', name: 'Jacket', quantity: 1, status: 'PROCESSING', note: 'Small tear near the left cuff; see desk intake note.' },
    ],
  },
  {
    id: 'ord-10471', orderNumber: 'SO-10471', customer: 'Grace T.', customerNumber: 'CUS-20091', branch: 'Kololo Branch', recordedBy: 'Daniel O.',
    receivedAt: '12:40 PM', receivedDate: today, dueAt: '4:00 PM', express: false,
    items: [
      { id: '10471-1', name: 'Bed sheets', quantity: 2, status: 'READY', note: '', readyAt: today, readyAtTime: '12:45 PM' },
      { id: '10471-2', name: 'Table cloth', quantity: 1, status: 'READY', note: '', readyAt: today, readyAtTime: '12:30 PM' },
    ],
  },
  ...Array.from({ length: 20 }, (_, index): WorkOrder => {
    const orderNumber = 10470 - index;
    const daysAgo = Math.floor(index / 4);
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - daysAgo);
    const receivedDate = localDateKey(orderDate);
    const hour = 11 - (index % 4);
    const minute = ['45', '20', '55', '30'][index % 4];
    const receivedAt = `${hour}:${minute} AM`;
    const branch = index % 2 === 0 ? 'Ntinda Branch' : 'Kololo Branch';
    const statusCycle: ItemStatus[] = ['RECEIVED', 'PROCESSING', 'READY'];
    const fullyReady = index % 6 === 0;
    const firstStatus: ItemStatus = fullyReady ? 'READY' : statusCycle[index % statusCycle.length];
    const secondStatus: ItemStatus = fullyReady ? 'READY' : statusCycle[(index + 1) % statusCycle.length];
    const firstName = ['Dress shirt', 'Trousers', 'Duvet cover', 'Polo shirt', 'Bed sheet'][index % 5];
    const secondName = ['Tie', 'Jacket', 'Pillow covers', 'Work shirt', 'Curtains'][index % 5];
    return {
      id: `ord-${orderNumber}`,
      orderNumber: `SO-${orderNumber}`,
      customer: ['Brian K.', 'Sarah A.', 'Joseph M.', 'Lydia T.', 'Patrick N.'][index % 5],
      customerNumber: `CUS-${20430 + index}`,
      branch,
      recordedBy: ['Nadia S.', 'James M.', 'Sarah K.', 'Daniel O.'][index % 4],
      receivedAt,
      receivedDate,
      dueAt: `${3 + (index % 5)}:00 PM`,
      express: index % 5 === 2,
      agentNote: index % 5 === 0 ? 'Please check the color and care label before processing.' : undefined,
      items: [
        { id: `${orderNumber}-1`, name: firstName, quantity: 1 + (index % 3), status: firstStatus, note: index % 3 === 0 ? 'Navy blue; check the left cuff.' : '', ...(firstStatus === 'READY' ? { readyAt: receivedDate, readyAtTime: receivedAt } : {}) },
        { id: `${orderNumber}-2`, name: secondName, quantity: 1 + ((index + 1) % 3), status: secondStatus, note: index % 4 === 1 ? 'White with a dark blue border.' : '', ...(secondStatus === 'READY' ? { readyAt: receivedDate, readyAtTime: receivedAt } : {}) },
      ],
    };
  }),
];

const initialMessages: DemoMessage[] = [
  { id: 'msg-1', branch: 'Ntinda Branch', orderNumber: 'SO-10482', sender: 'Ntinda receiving desk', message: 'Express order. Customer is waiting nearby and requested it by 3:45 PM.', time: '2:20 PM', outgoing: false },
  { id: 'msg-2', branch: 'Kololo Branch', orderNumber: 'SO-10479', sender: 'Kololo receiving desk', message: 'Please confirm when the duvet cover is ready for the desk.', time: '1:56 PM', outgoing: false },
  { id: 'msg-3', branch: 'Ntinda Branch', orderNumber: 'SO-10476', sender: 'Operations', message: 'Trousers are ready. Jacket is still processing.', time: '2:04 PM', outgoing: true },
];

type DeliveredOrderItem = {
  id: string;
  name: string;
  quantity: number;
  note: string;
};

type DeliveredOrderRecord = {
  id: string;
  orderNumber: string;
  customer: string;
  customerNumber: string;
  branch: string;
  items: DeliveredOrderItem[];
  releasedDate: string;
  releasedTime: string;
};

const demoDeliveredOrders: DeliveredOrderRecord[] = Array.from({ length: 24 }, (_, index) => {
  const daysAgo = [0, 0, 1, 2, 4, 6, 7, 12, 20, 31, 60, 90, 150, 200, 320, 365, 380, 400, 420, 450, 500, 540, 700, 900][index];
  const hour24 = 17 - (index % 8);
  const minute = String((index * 7) % 60).padStart(2, '0');
  const itemNames = [
    ['Trousers', 'Business shirt', 'Tie'],
    ['Duvet cover', 'Pillow covers'],
    ['Jacket', 'Dress shirt'],
    ['Bed sheets', 'Table cloth', 'Curtains'],
    ['Polo shirt', 'Trousers'],
    ['Dress', 'Scarf'],
  ][index % 6];
  return {
    id: `released-order-${index + 1}`,
    orderNumber: `SO-${10280 - index}`,
    customer: ['Miriam Nansubuga', 'Amina Kato', 'Peter Ssemanda', 'Grace Tumusiime', 'Daniel Okello', 'Lydia Namutebi'][index % 6],
    customerNumber: `CUS-${19840 + index}`,
    branch: index % 2 === 0 ? 'Ntinda Branch' : 'Kololo Branch',
    releasedDate: relativeDate(daysAgo),
    releasedTime: `${hour24 > 12 ? hour24 - 12 : hour24}:${minute} ${hour24 >= 12 ? 'PM' : 'AM'}`,
    items: itemNames.map((name, itemIndex) => ({
      id: `released-${index + 1}-${itemIndex + 1}`,
      name,
      quantity: 1 + ((index + itemIndex) % 3),
      note: (index + itemIndex) % 3 === 0 ? 'Navy blue item; left cuff checked before release.' : (index + itemIndex) % 3 === 1 ? 'Customer noted a small button repair at intake.' : '',
    })),
  };
});

const OperationsDemo = () => {
  const navigate = useNavigate();
  const { isAuthenticated, canAccessOperations, canAccessDesktopWorkspace } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const allowedPages: AppPage[] = ['dashboard', 'queue', 'reports', 'messages', 'delivered'];
  const requestedPage = searchParams.get('view') as AppPage | null;
  const page: AppPage = requestedPage && allowedPages.includes(requestedPage) ? requestedPage : 'dashboard';
  const setPage = (nextPage: AppPage) => setSearchParams({ view: nextPage });
  const [orders, setOrders] = useState<WorkOrder[]>(initialOrders);
  const [messages, setMessages] = useState<DemoMessage[]>(initialMessages);
  const [branch, setBranch] = useState('All branches');
  const [search, setSearch] = useState('');
  const [itemType, setItemType] = useState('All items');
  const [queueStatus, setQueueStatus] = useState<QueueStatus>('ALL');
  const [expandedOrder, setExpandedOrder] = useState('ord-10482');
  const [notice, setNotice] = useState('');
  const [reportPeriod, setReportPeriod] = useState<'all' | 'today' | 'month' | 'custom'>('all');
  const [reportFrom, setReportFrom] = useState(today);
  const [reportTo, setReportTo] = useState(today);
  const [reportSearch, setReportSearch] = useState('');
  const [reportBranch, setReportBranch] = useState('All branches');
  const [messageBranch, setMessageBranch] = useState('Ntinda Branch');
  const [messageOrder, setMessageOrder] = useState('SO-10482');
  const [messageDraft, setMessageDraft] = useState('');

  const allItems = useMemo(() => orders.flatMap((order) => order.items.map((item) => ({ ...item, order }))), [orders]);
  const branchOptions = useMemo(() => ['All branches', ...Array.from(new Set(orders.map((order) => order.branch)))], [orders]);
  const messageBranchOptions = branchOptions.filter((option) => option !== 'All branches');
  const activeOrders = orders;
  const itemCounts = {
    received: allItems.filter(({ status }) => status === 'RECEIVED').length,
    processing: allItems.filter(({ status }) => status === 'PROCESSING').length,
    ready: allItems.filter(({ status }) => status === 'READY').length,
    express: activeOrders.filter((order) => order.express).length,
  };

  const filteredOrders = useMemo(() => orders
    .filter((order) => branch === 'All branches' || order.branch === branch)
    .map((order) => ({
      ...order,
      visibleItems: order.items.filter((item) => {
        const statusMatch = queueStatus === 'ALL' || (queueStatus === 'EXPRESS' ? order.express : item.status === queueStatus);
        const typeMatch = itemType === 'All items' || item.name.toLowerCase().includes(itemType.toLowerCase().replace(/s$/, ''));
        const searchMatch = `${order.orderNumber} ${order.customer} ${order.branch} ${item.name}`.toLowerCase().includes(search.toLowerCase());
        return statusMatch && typeMatch && searchMatch;
      }),
    }))
    .filter((order) => order.visibleItems.length > 0)
    .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || timeToMinutes(b.receivedAt) - timeToMinutes(a.receivedAt) || Number(b.express) - Number(a.express)),
  [orders, branch, queueStatus, itemType, search]);

  const readyReportItems = useMemo(() => allItems.filter((entry) => {
    if (entry.status !== 'READY' || !entry.readyAt) return false;
    if (reportBranch !== 'All branches' && entry.order.branch !== reportBranch) return false;
    if (!`${entry.order.orderNumber} ${entry.order.customer} ${entry.order.branch} ${entry.name}`.toLowerCase().includes(reportSearch.toLowerCase())) return false;
    if (reportPeriod === 'all') return true;
    if (reportPeriod === 'today') return entry.readyAt === today;
    if (reportPeriod === 'month') return entry.readyAt.slice(0, 7) === today.slice(0, 7);
    return entry.readyAt >= reportFrom && entry.readyAt <= reportTo;
  }).sort((a, b) => (b.readyAt || '').localeCompare(a.readyAt || '') || timeToMinutes(b.readyAtTime || b.order.receivedAt) - timeToMinutes(a.readyAtTime || a.order.receivedAt) || b.order.receivedDate.localeCompare(a.order.receivedDate)), [allItems, reportBranch, reportSearch, reportPeriod, reportFrom, reportTo]);

  const changeItemStatus = (orderId: string, itemId: string, nextStatus: ItemStatus) => {
    setOrders((current) => current.map((order) => order.id !== orderId ? order : {
      ...order,
      items: order.items.map((item) => item.id !== itemId ? item : {
        ...item,
        status: nextStatus,
        readyAt: nextStatus === 'READY' ? today : undefined,
        readyAtTime: nextStatus === 'READY' ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined,
      }),
    }));
    const order = orders.find((item) => item.id === orderId);
    const item = order?.items.find((entry) => entry.id === itemId);
    setNotice(nextStatus === 'READY'
      ? `${item?.name || 'Item'} from ${order?.orderNumber || 'this order'} marked ready. The ${order?.branch || 'receiving'} desk is notified in this demo.`
      : `${item?.name || 'Item'} from ${order?.orderNumber || 'this order'} moved to processing.`);
  };

  const updateItemNote = (orderId: string, itemId: string, note: string) => {
    setOrders((current) => current.map((order) => order.id !== orderId ? order : {
      ...order,
      items: order.items.map((item) => item.id !== itemId ? item : { ...item, note }),
    }));
  };

  const simulateIncomingOrder = () => {
    const number = 10483 + orders.length - initialOrders.length;
    const nextBranch = branch !== 'All branches' ? branch : 'Ntinda Branch';
    const newOrder: WorkOrder = {
      id: `ord-${number}`, orderNumber: `SO-${number}`, customer: 'Daniel O.', customerNumber: 'CUS-20881', branch: nextBranch, recordedBy: 'Nadia S.',
      receivedAt: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      receivedDate: today, dueAt: '6:30 PM', express: false,
      agentNote: 'New order received at the branch and sent to the Operations queue.',
      items: [
        { id: `${number}-1`, name: 'Duvet', quantity: 1, status: 'RECEIVED', note: '' },
        { id: `${number}-2`, name: 'Polo shirt', quantity: 2, status: 'RECEIVED', note: '' },
      ],
    };
    setOrders((current) => [newOrder, ...current]);
    setExpandedOrder(newOrder.id);
    setPage('queue');
    setQueueStatus('RECEIVED');
    setNotice(`${newOrder.orderNumber} just arrived from ${newOrder.branch}. It appeared in the new-items queue automatically in this demo.`);
  };

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!messageDraft.trim()) return;
    const message: DemoMessage = {
      id: `msg-${Date.now()}`, branch: messageBranch, orderNumber: messageOrder,
      sender: 'Operations', message: messageDraft.trim(), time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), outgoing: true,
    };
    setMessages((current) => [message, ...current]);
    setMessageDraft('');
    setNotice(`Message about ${messageOrder} sent to ${messageBranch} in this demo.`);
  };

  const downloadCsv = () => {
    const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [
      ['Ready date', 'Ready time', 'Order number', 'Customer', 'Branch', 'Item', 'Quantity', 'Item note'],
      ...readyReportItems.map((entry) => [entry.readyAt || '', entry.readyAtTime || '', entry.order.orderNumber, entry.order.customer, entry.order.branch, entry.name, entry.quantity, entry.note]),
    ];
    const content = rows.map((row) => row.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `operations-ready-items-${today}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (isAuthenticated && !canAccessOperations) return <Navigate to="/dashboard" replace />;

  const pageTitles: Record<AppPage, string> = {
    dashboard: 'Operations Workspace',
    queue: 'Work Queue',
    messages: 'Messages',
    reports: 'Reports',
    delivered: 'Delivered Items',
  };

  return (
    <MainLayout
      demoMode={!isAuthenticated}
      operationsMode={isAuthenticated}
      title={pageTitles[page]}
      subtitle="Operations preview · sample data"
      onDemoSearch={(query) => { setSearch(query); setPage('queue'); }}
      onExitDemo={() => navigate('/login')}
      onExitOperations={canAccessDesktopWorkspace ? () => navigate('/dashboard') : undefined}
    >
    <div className="operations-preview bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="ops-content min-w-0">
        <main className="ops-content-main w-full max-w-none min-w-0 space-y-5 sm:space-y-6 print:max-w-none print:bg-white print:p-0 print:text-black">
          {notice && <div className="flex items-start justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100 print:hidden" role="status"><p>{notice}</p><button className="shrink-0 font-semibold" onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

          {page === 'dashboard' && (
            <DashboardView
              orders={orders}
              itemCounts={itemCounts}
              onOpenQueue={() => setPage('queue')}
              onOpenReports={() => setPage('reports')}
              onOpenOrder={(id) => { setBranch('All branches'); setSearch(''); setItemType('All items'); setQueueStatus('ALL'); setExpandedOrder(id); setPage('queue'); }}
              onSimulateIncoming={simulateIncomingOrder}
            />
          )}

          {page === 'queue' && (
            <QueueView
              orders={filteredOrders}
              branch={branch}
              branchOptions={branchOptions}
              setBranch={setBranch}
              search={search}
              setSearch={setSearch}
              itemType={itemType}
              setItemType={setItemType}
              queueStatus={queueStatus}
              setQueueStatus={setQueueStatus}
              expandedOrder={expandedOrder}
              setExpandedOrder={setExpandedOrder}
              onStatusChange={changeItemStatus}
              onNoteChange={updateItemNote}
              onOpenMessages={(order) => { setMessageOrder(order.orderNumber); setMessageBranch(order.branch); setPage('messages'); }}
              onNoteSaved={(order, item) => setNotice(`Item note saved. ${order.orderNumber} · ${item.name} note is visible to ${order.branch} in this demo.`)}
              onSimulateIncoming={simulateIncomingOrder}
            />
          )}

          {page === 'reports' && (
            <ReportsView
              reportPeriod={reportPeriod}
              setReportPeriod={setReportPeriod}
              reportFrom={reportFrom}
              setReportFrom={setReportFrom}
              reportTo={reportTo}
              setReportTo={setReportTo}
              reportSearch={reportSearch}
              setReportSearch={setReportSearch}
              reportBranch={reportBranch}
              setReportBranch={setReportBranch}
              branchOptions={branchOptions}
              rows={readyReportItems}
              onDownloadCsv={downloadCsv}
            />
          )}

          {page === 'delivered' && (
            <DeliveredItemsView orders={demoDeliveredOrders} branchOptions={branchOptions.filter((option) => option !== 'All branches')} />
          )}

          {page === 'messages' && (
            <MessagesView
              messages={messages}
              orders={orders}
              messageBranch={messageBranch}
              branchOptions={messageBranchOptions}
              onMessageBranchChange={(value) => {
                setMessageBranch(value);
                const firstOrder = orders.find((order) => order.branch === value);
                if (firstOrder) setMessageOrder(firstOrder.orderNumber);
              }}
              messageOrder={messageOrder}
              setMessageOrder={setMessageOrder}
              messageDraft={messageDraft}
              setMessageDraft={setMessageDraft}
              onSend={sendMessage}
            />
          )}

          <div className="border-t pt-4 text-xs text-slate-500 dark:border-slate-800 print:hidden"><strong className="text-slate-700 dark:text-slate-300">Demo only:</strong> order updates, notes, reports, and messages stay in browser state. No live backend calls are made.</div>
        </main>
      </div>
    </div>
    </MainLayout>
  );
};

const branchPalette = [
  { accent: '#0a64e0', badge: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200', dot: 'bg-blue-600' },
  { accent: '#ea580c', badge: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200', dot: 'bg-orange-600' },
  { accent: '#7c3aed', badge: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200', dot: 'bg-violet-600' },
  { accent: '#0f766e', badge: 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200', dot: 'bg-teal-600' },
];

function getBranchVisual(branch: string) {
  const normalized = branch.trim().toLowerCase();
  if (normalized.includes('ntinda') || normalized.includes('main')) return branchPalette[0];
  if (normalized.includes('kololo')) return branchPalette[1];
  const hash = [...normalized].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return branchPalette[hash % branchPalette.length];
}

function BranchBadge({ branch }: { branch: string }) {
  const visual = getBranchVisual(branch);
  return <Badge variant="outline" className={`inline-flex items-center gap-1.5 whitespace-nowrap font-bold ${visual.badge}`}><span aria-hidden="true" className={`h-2 w-2 rounded-full ${visual.dot}`} />{branch}</Badge>;
}

function DashboardView({ orders, itemCounts, onOpenQueue, onOpenReports, onOpenOrder, onSimulateIncoming }: {
  orders: WorkOrder[];
  itemCounts: { received: number; processing: number; ready: number; express: number };
  onOpenQueue: () => void;
  onOpenReports: () => void;
  onOpenOrder: (id: string) => void;
  onSimulateIncoming: () => void;
}) {
  const recent = [...orders].sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || timeToMinutes(b.receivedAt) - timeToMinutes(a.receivedAt)).slice(0, 4);
  const express = orders.filter((order) => order.express);
  return <div className="space-y-6">
    <section className="ops-dashboard-hero relative isolate overflow-hidden rounded-2xl bg-gradient-to-br from-blue-950 via-blue-900 to-slate-900 p-5 text-white shadow-lg shadow-blue-950/10 sm:p-7"><div className="pointer-events-none absolute -right-10 -top-16 -z-10 h-56 w-56 rounded-full bg-orange-400/20 blur-3xl" /><div className="pointer-events-none absolute bottom-0 right-1/3 -z-10 h-36 w-36 rounded-full bg-sky-300/10 blur-3xl" /><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><Badge variant="outline" className="mb-2 border-orange-300 text-orange-200"><Sparkles className="mr-1 h-3 w-3" />Optional Operations workspace</Badge><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Operations dashboard</h1><p className="mt-1 max-w-2xl text-sm text-blue-100/80">Track laundry work from intake through ready. Branch staff continue using the main system alongside this optional workspace.</p></div><Button variant="outline" className="w-full border-white/25 bg-white/10 text-white hover:bg-white/20 sm:w-auto print:hidden" onClick={onSimulateIncoming}><Plus className="mr-2 h-4 w-4" />Preview incoming order</Button></div></section>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4"><StatCard icon={<PackageCheck className="h-5 w-5" />} label="Newly received items" value={itemCounts.received} detail="Waiting to be started" tone="orange" /><StatCard icon={<WashingMachine className="h-5 w-5" />} label="Processing items" value={itemCounts.processing} detail="Currently being worked on" tone="blue" /><StatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Ready items" value={itemCounts.ready} detail="All work completed" tone="green" /><StatCard icon={<Sparkles className="h-5 w-5" />} label="Express orders" value={itemCounts.express} detail="Prioritize in the queue" tone="orange" /></div>
    <Card><CardContent className="p-4 sm:p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Recent orders</h2><p className="mt-1 text-sm text-slate-500">Newest orders first ? readiness by item</p></div><Button className="bg-orange-500 font-bold text-slate-950 hover:bg-orange-600" onClick={onOpenQueue}>Open work queue</Button></div>{recent.length ? <div className="space-y-2">{recent.map((order) => { const readyCount = order.items.filter((item) => item.status === 'READY').length; const ready = order.items.length > 0 && readyCount === order.items.length; return <button key={order.id} onClick={() => onOpenOrder(order.id)} className={`ops-recent-order flex w-full flex-col gap-3 rounded-xl border border-slate-200 p-3 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800 sm:flex-row sm:items-center sm:justify-between ${ready ? 'ops-recent-order-ready' : ''}`} style={{ borderLeftColor: getBranchVisual(order.branch).accent }}><span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><strong>{order.orderNumber}</strong>{order.express && <Badge className="bg-orange-500 text-slate-950 hover:bg-orange-500">Express ? due {order.dueAt}</Badge>}</span><span className="mt-1 flex flex-wrap items-center gap-2 font-medium">{order.customer}<BranchBadge branch={order.branch} /></span><span className="mt-1 block text-xs text-slate-500">Customer ID {order.customerNumber} ? received {order.receivedAt}</span></span><span className="ops-recent-order-progress w-full shrink-0"><span className="mb-1 flex items-center justify-between text-xs font-bold text-slate-500"><span>{ready ? 'Ready' : readyCount === 0 ? 'Received' : 'Processing'}</span><span>{readyCount}/{order.items.length} items</span></span><span className="ops-progress-track"><span style={{ width: `${order.items.length ? readyCount / order.items.length * 100 : 0}%` }} /></span></span></button>; })}</div> : <p className="py-8 text-center text-sm text-slate-500">New orders will appear here when branch staff enter them.</p>}</CardContent></Card>
    <div className="grid gap-4 lg:grid-cols-2"><Card className="border-orange-200 dark:border-orange-950"><CardContent className="p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Express priority</h2><p className="mt-1 text-sm text-slate-500">Urgent branch requests stay highlighted.</p></div><Badge variant="secondary" className="bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200">{express.length} active</Badge></div>{express.length ? <div className="space-y-2">{express.map((order) => <button key={order.id} onClick={() => onOpenOrder(order.id)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-orange-200 bg-orange-50/70 p-3 text-left hover:bg-orange-100 dark:border-orange-900 dark:bg-orange-950/20"><span><strong>{order.orderNumber} ? {order.customer}</strong><span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><BranchBadge branch={order.branch} /><span>Due {order.dueAt}</span></span></span><ChevronRight className="h-4 w-4 shrink-0 text-orange-700" /></button>)}</div> : <p className="text-sm text-slate-500">No express orders in the sample.</p>}</CardContent></Card><Card><CardContent className="p-5"><div className="mb-4"><h2 className="text-lg font-semibold">Quick access</h2><p className="mt-1 text-sm text-slate-500">Review active work and completed item reports.</p></div><div className="space-y-2"><QuickLink label="Open work queue" detail={`${itemCounts.received + itemCounts.processing} items need attention`} onClick={onOpenQueue} /><QuickLink label="Review ready-item report" detail="Filter by day, month, branch, or dates" onClick={onOpenReports} /></div></CardContent></Card></div>
  </div>;
}

function QueueView({ orders, branch, setBranch, branchOptions, search, setSearch, itemType, setItemType, queueStatus, setQueueStatus, expandedOrder, setExpandedOrder, onStatusChange, onNoteChange, onNoteSaved, onOpenMessages, onSimulateIncoming }: {
  orders: (WorkOrder & { visibleItems: WorkItem[] })[];
  branch: string;
  setBranch: (value: string) => void;
  branchOptions: string[];
  search: string;
  setSearch: (value: string) => void;
  itemType: string;
  setItemType: (value: string) => void;
  queueStatus: QueueStatus;
  setQueueStatus: (value: QueueStatus) => void;
  expandedOrder: string;
  setExpandedOrder: (value: string) => void;
  onStatusChange: (orderId: string, itemId: string, status: ItemStatus) => void;
  onNoteChange: (orderId: string, itemId: string, note: string) => void;
  onNoteSaved: (order: WorkOrder, item: WorkItem) => void;
  onOpenMessages: (order: WorkOrder) => void;
  onSimulateIncoming: () => void;
}) {
  const [period, setPeriod] = useState<'all' | 'today' | 'month' | 'custom'>('all');
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const tabs: { status: QueueStatus; label: string }[] = [{ status: 'ALL', label: 'All' }, { status: 'RECEIVED', label: 'Received' }, { status: 'PROCESSING', label: 'Processing' }, { status: 'READY', label: 'Ready' }, { status: 'EXPRESS', label: 'Express' }];
  const filteredByDate = orders.filter((order) => {
    if (period === 'today' && order.receivedDate !== today) return false;
    if (period === 'month' && order.receivedDate.slice(0, 7) !== today.slice(0, 7)) return false;
    if (period === 'custom' && (order.receivedDate < dateFrom || order.receivedDate > dateTo)) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredByDate.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageOrders = filteredByDate.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const changeFilter = (update: () => void) => { update(); setPage(1); };
  useEffect(() => {
    const targetIndex = filteredByDate.findIndex((order) => order.id === expandedOrder);
    if (targetIndex >= 0) {
      const targetPage = Math.floor(targetIndex / pageSize) + 1;
      setPage((current) => current === targetPage ? current : targetPage);
    }
  }, [expandedOrder, filteredByDate, pageSize]);
  return <div className="space-y-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><h1 className="text-2xl font-bold">Work queue</h1><p className="mt-1 text-sm text-slate-500">Expand an order to track each item from received through processing to ready.</p></div><Button variant="outline" className="print:hidden" onClick={onSimulateIncoming}><Plus className="mr-2 h-4 w-4" />Preview incoming order</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2 overflow-x-auto">{([{ value: 'all', label: 'All time' }, { value: 'today', label: 'Today' }, { value: 'month', label: 'This month' }, { value: 'custom', label: 'Custom dates' }] as const).map((filter) => <button key={filter.value} onClick={() => changeFilter(() => setPeriod(filter.value))} aria-pressed={period === filter.value} className={`shrink-0 rounded-full border px-4 py-2 text-sm font-bold ${period === filter.value ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}>{filter.label}</button>)}</div><span className="text-sm font-semibold text-slate-500">{filteredByDate.length} orders</span></div>
    {period === 'custom' && <div className="grid gap-3 rounded-xl border bg-white p-4 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2"><label className="space-y-1 text-xs text-slate-500">From<Input type="date" value={dateFrom} onChange={(event) => changeFilter(() => setDateFrom(event.target.value))} /></label><label className="space-y-1 text-xs text-slate-500">To<Input type="date" value={dateTo} onChange={(event) => changeFilter(() => setDateTo(event.target.value))} /></label></div>}
    <div className="flex flex-col gap-3 rounded-xl border bg-white p-4 dark:border-slate-800 dark:bg-slate-900 print:hidden"><div className="flex gap-2 overflow-x-auto">{tabs.map((tab) => { const count = tab.status === 'ALL' ? filteredByDate.length : tab.status === 'EXPRESS' ? filteredByDate.filter((order) => order.express).length : filteredByDate.filter((order) => order.items.some((item) => item.status === tab.status)).length; return <button key={tab.status} onClick={() => changeFilter(() => setQueueStatus(tab.status))} aria-pressed={queueStatus === tab.status} className={`chip shrink-0 rounded-full border px-4 py-2 text-sm font-extrabold ${queueStatus === tab.status ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}>{tab.label} <span className="ml-1 opacity-80">{count}</span></button>; })}</div><div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3"><div className="relative min-w-0"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input className="min-w-0 pl-9" value={search} onChange={(event) => changeFilter(() => setSearch(event.target.value))} placeholder="Search order, customer, ID or branch" aria-label="Search orders" /></div><SelectFilter label="Branch" value={branch} onChange={(value) => changeFilter(() => setBranch(value))} values={branchOptions} /><SelectFilter label="Item type" value={itemType} onChange={(value) => changeFilter(() => setItemType(value))} values={['All items', 'Shirts', 'Duvets', 'Dresses', 'Trousers', 'Jackets']} /></div></div>
    <div className="space-y-3">{pageOrders.length ? pageOrders.map((order) => { const expanded = expandedOrder === order.id; const readyCount = order.items.filter((item) => item.status === 'READY').length; const orderReady = order.items.length > 0 && readyCount === order.items.length; return <Card key={order.id} className={`ops-order-card ${expanded ? 'ops-order-card-expanded' : ''} ${order.express ? 'border-orange-300 dark:border-orange-900' : ''}`}><CardContent className="p-0"><button className={`ops-order-header ${orderReady ? 'ops-order-ready' : ''} ${expanded ? 'ops-order-expanded' : ''}`} style={{ borderLeftColor: getBranchVisual(order.branch).accent }} onClick={() => setExpandedOrder(expanded ? '' : order.id)} aria-expanded={expanded}><span className="ops-order-primary"><span className="ops-order-title-line"><strong>{order.orderNumber}</strong>{expanded && <Badge variant="outline" className="ops-expanded-badge">Expanded - click to collapse</Badge>}{order.express && <Badge variant="secondary" className="bg-orange-500 text-slate-950"><Sparkles className="mr-1 h-3 w-3" />Express ? due {order.dueAt}</Badge>}</span><span className="ops-order-customer">{order.customer}</span><span className="ops-order-meta">Customer ID {order.customerNumber}</span></span><span className="ops-order-branch"><BranchBadge branch={order.branch} /><span className="ops-order-meta">Agent {order.recordedBy}</span><span className="ops-order-meta">Received {order.receivedAt}</span></span><span className="ops-order-progress"><span className="ops-order-progress-label"><Badge variant="outline" className={orderReady ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300' : 'border-blue-200 text-blue-700 dark:text-blue-200'}>{orderReady ? 'Ready' : readyCount === 0 ? 'Received' : 'Processing'}</Badge><span>{readyCount} of {order.items.length} items ready</span></span><span className="ops-progress-track" role="progressbar" aria-label={`${order.orderNumber} readiness`} aria-valuemin={0} aria-valuemax={order.items.length} aria-valuenow={readyCount}><span style={{ width: `${order.items.length ? readyCount / order.items.length * 100 : 0}%` }} /></span></span><span className="ops-order-chevron" aria-hidden="true">{expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}</span></button>{expanded && <div className="ops-order-body space-y-3 border-t px-3 py-4 dark:border-slate-800 sm:px-5">{order.agentNote && <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/20"><p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Desk note</p><p className="mt-1 text-slate-700 dark:text-slate-200">{order.agentNote}</p></div>}<div className="hidden overflow-x-auto rounded-lg border dark:border-slate-800 md:block"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800"><tr><th className="px-3 py-3">Item</th><th className="px-3 py-3">Quantity</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Notes</th><th className="px-3 py-3 text-right">Action</th></tr></thead><tbody>{order.visibleItems.map((item) => <ItemWorkRow key={item.id} order={order} item={item} onStatusChange={onStatusChange} onNoteChange={onNoteChange} onNoteSaved={onNoteSaved} />)}</tbody></table></div><div className="space-y-2 md:hidden">{order.visibleItems.map((item) => <ItemWorkCard key={`mobile-${item.id}`} order={order} item={item} onStatusChange={onStatusChange} onNoteChange={onNoteChange} onNoteSaved={onNoteSaved} />)}</div><div className="flex flex-col justify-between gap-2 border-t pt-3 dark:border-slate-800 sm:flex-row sm:items-center"><p className="text-xs text-slate-500">Operations updates item progress only. All other order work stays in the main system.</p><Button variant="outline" size="sm" className="print:hidden" onClick={() => onOpenMessages(order)}><MessageCircle className="mr-2 h-4 w-4" />Message {order.branch}</Button></div></div>}</CardContent></Card>; }) : <Card><CardContent className="py-14 text-center"><PackageCheck className="mx-auto h-10 w-10 text-slate-300" /><h2 className="mt-3 font-semibold">No matching orders</h2><p className="mt-1 text-sm text-slate-500">Try another date, branch, item type, search, or status filter.</p></CardContent></Card>}</div>
    <PaginationControls currentPage={currentPage} pageCount={pageCount} total={filteredByDate.length} pageSize={pageSize} onPageChange={setPage} label="orders" />
  </div>;
}

function ItemWorkRow({ order, item, onStatusChange, onNoteChange, onNoteSaved }: {
  order: WorkOrder;
  item: WorkItem;
  onStatusChange: (orderId: string, itemId: string, status: ItemStatus) => void;
  onNoteChange: (orderId: string, itemId: string, note: string) => void;
  onNoteSaved: (order: WorkOrder, item: WorkItem) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const statusStyle = item.status === 'READY' ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300' : item.status === 'PROCESSING' ? 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300' : 'border-orange-300 text-orange-700 dark:border-orange-800 dark:text-orange-300';
  return <>
    <tr className="border-t align-top dark:border-slate-800"><td className="px-3 py-3 font-medium">{item.name}</td><td className="px-3 py-3">{item.quantity}</td><td className="px-3 py-3"><Badge variant="outline" className={statusStyle}>{statusLabel(item.status)}</Badge></td><td className="max-w-xs whitespace-normal px-3 py-3"><div className="flex flex-wrap gap-2">{item.note && <button className="text-left text-blue-700 underline dark:text-blue-300" onClick={() => setNoteOpen((open) => !open)}>{noteOpen ? 'Hide note' : 'View note'}</button>}<button className="text-left text-blue-700 underline dark:text-blue-300" onClick={() => { setEditingNote((open) => !open); setNoteOpen(true); }}>{item.note ? 'Add or edit note' : 'Add note'}</button></div>{noteOpen && item.note && !editingNote && <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{item.note}</p>}{noteOpen && editingNote && <div className="mt-2 min-w-56 space-y-2"><Input value={item.note} onChange={(event) => onNoteChange(order.id, item.id, event.target.value)} placeholder="Example: blue stitching on the left cuff" /><Button size="sm" variant="outline" onClick={() => { setEditingNote(false); setNoteOpen(Boolean(item.note)); onNoteSaved(order, item); }}>Save note</Button></div>}</td><td className="px-3 py-3 text-right"><ItemStatusAction order={order} item={item} onStatusChange={onStatusChange} /></td></tr>
  </>;
}

function ItemWorkCard({ order, item, onStatusChange, onNoteChange, onNoteSaved }: {
  order: WorkOrder;
  item: WorkItem;
  onStatusChange: (orderId: string, itemId: string, status: ItemStatus) => void;
  onNoteChange: (orderId: string, itemId: string, note: string) => void;
  onNoteSaved: (order: WorkOrder, item: WorkItem) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  return <div className="rounded-lg border p-3 dark:border-slate-800"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.name} <span className="font-normal text-slate-500">? {item.quantity}</span></p><div className="mt-2"><Badge variant="outline">{statusLabel(item.status)}</Badge></div></div><ItemStatusAction order={order} item={item} onStatusChange={onStatusChange} /></div><div className="mt-3 border-t pt-3 dark:border-slate-800"><p className="text-xs font-medium text-slate-500">Item notes</p>{item.note ? <button className="mt-1 text-sm text-blue-700 underline dark:text-blue-300" onClick={() => setNoteOpen((open) => !open)}>{noteOpen ? 'Hide note' : 'View note'}</button> : <span className="mt-1 block text-sm text-slate-400">No note recorded</span>}{noteOpen && item.note && <p className="mt-2 text-sm">{item.note}</p>}<Button variant="outline" size="sm" className="mt-2" onClick={() => setNoteOpen((open) => !open)}>{item.note ? 'Add or edit note' : 'Add note'}</Button>{noteOpen && <div className="mt-2 space-y-2"><Input value={item.note} onChange={(event) => onNoteChange(order.id, item.id, event.target.value)} placeholder="Example: blue stitching on the left cuff" /><Button size="sm" variant="outline" onClick={() => { setNoteOpen(false); onNoteSaved(order, item); }}>Save note</Button></div>}</div></div>;
}

function ItemStatusAction({ order, item, onStatusChange }: { order: WorkOrder; item: WorkItem; onStatusChange: (orderId: string, itemId: string, status: ItemStatus) => void }) {
  if (item.status === 'RECEIVED') return <Button size="sm" className="bg-blue-700 text-white hover:bg-blue-800" onClick={() => onStatusChange(order.id, item.id, 'PROCESSING')}><WashingMachine className="mr-1 h-4 w-4" />Start processing</Button>;
  if (item.status === 'PROCESSING') return <button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-emerald-300 bg-white px-3 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50 dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-200" onClick={() => onStatusChange(order.id, item.id, 'READY')}><Check className="h-4 w-4" />Mark ready</button>;
  return <Button variant="outline" size="sm" className="border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200" onClick={() => onStatusChange(order.id, item.id, 'PROCESSING')}>Reopen item</Button>;
}

function timeToMinutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return 0;
  const hour = Number(match[1]) % 12;
  return hour * 60 + Number(match[2]) + (match[3].toUpperCase() === 'PM' ? 12 * 60 : 0);
}

function DeliveredItemsView({ orders, branchOptions }: { orders: DeliveredOrderRecord[]; branchOptions: string[] }) {
  const [period, setPeriod] = useState<'all' | 'today' | 'week' | 'last-year' | 'custom'>('all');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('All branches');
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const pageSize = 20;
  const weekStartDate = new Date();
  weekStartDate.setDate(weekStartDate.getDate() - ((weekStartDate.getDay() + 6) % 7));
  const weekStart = localDateKey(weekStartDate);
  const previousYear = String(Number(today.slice(0, 4)) - 1);
  const filteredOrders = orders.filter((order) => {
    if (period === 'today' && order.releasedDate !== today) return false;
    if (period === 'week' && order.releasedDate < weekStart) return false;
    if (period === 'last-year' && order.releasedDate.slice(0, 4) !== previousYear) return false;
    if (period === 'custom' && (order.releasedDate < from || order.releasedDate > to)) return false;
    if (branch !== 'All branches' && order.branch !== branch) return false;
    const itemText = order.items.map((item) => `${item.name} ${item.note}`).join(' ');
    return `${order.orderNumber} ${order.customer} ${order.customerNumber} ${order.branch} ${itemText}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => b.releasedDate.localeCompare(a.releasedDate) || timeToMinutes(b.releasedTime) - timeToMinutes(a.releasedTime));
  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageOrders = filteredOrders.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const choosePeriod = (value: typeof period) => { setPeriod(value); setPage(1); setExpandedIds(new Set()); };
  const toggle = (id: string) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const filters = [{ value: 'all', label: 'All time' }, { value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'last-year', label: 'Last year' }, { value: 'custom', label: 'Custom dates' }] as const;
  const periodLabel = period === 'all' ? 'All time' : period === 'today' ? 'Today' : period === 'week' ? 'This week' : period === 'last-year' ? previousYear : `${from} to ${to}`;
  return <div className="space-y-5">
    <div><Badge variant="outline" className="mb-2"><PackageCheck className="mr-1 h-3 w-3" />Read-only history</Badge><h1 className="text-2xl font-bold">Delivered Items</h1><p className="mt-1 max-w-3xl text-sm text-slate-500">When desktop staff mark an order delivered, all items in that order appear together here. Operations can review this history but cannot change it.</p></div>
    <div className="flex flex-wrap gap-2">{filters.map((filter) => <button key={filter.value} type="button" aria-pressed={period === filter.value} onClick={() => choosePeriod(filter.value)} className={`rounded-full px-4 py-2 text-sm font-bold ${period === filter.value ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>{filter.label}</button>)}</div>
    {period === 'custom' && <div className="grid gap-3 rounded-xl border bg-white p-4 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2"><label className="space-y-1 text-xs text-slate-500">From<Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label><label className="space-y-1 text-xs text-slate-500">To<Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label></div>}
    <div className="grid gap-2 rounded-xl border bg-white p-4 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-[minmax(0,1fr)_220px]"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search order, client, item, or branch" /></div><SelectFilter label="Branch" value={branch} onChange={(value) => { setBranch(value); setPage(1); }} values={['All branches', ...branchOptions]} /></div>
    <div className="flex items-center justify-between border-y py-3 dark:border-slate-800"><div><p className="font-semibold">Delivered orders</p><p className="text-xs text-slate-500">{periodLabel} ? {branch} ? newest first</p></div><Badge variant="secondary">{filteredOrders.length} orders</Badge></div>
    <div className="space-y-3 xl:hidden">{pageOrders.map((order) => { const expanded = expandedIds.has(order.id); return <article key={order.id} className="overflow-hidden rounded-xl border dark:border-slate-800"><button type="button" aria-expanded={expanded} onClick={() => toggle(order.id)} className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800"><span className="min-w-0"><span className="block font-semibold">{order.orderNumber}</span><span className="block break-words text-sm">{order.customer}</span><span className="mt-1 flex flex-wrap items-center gap-2"><BranchBadge branch={order.branch} /><span className="text-xs text-slate-500">{order.releasedDate} ? {order.releasedTime}</span></span></span><span className="flex shrink-0 items-center gap-2"><span className="flex flex-col items-end gap-1"><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Delivered</Badge><Badge variant="secondary">{order.items.length} items</Badge></span><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></span></button>{expanded && <div className="space-y-2 border-t bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900"><div className="text-xs text-slate-500">Customer ID: {order.customerNumber} ? Released by desktop staff</div>{order.items.map((item) => <div key={item.id} className="rounded-lg border bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-950"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{item.name} <span className="font-normal text-slate-500">? {item.quantity}</span></span><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Delivered</Badge></div><p className="mt-1 break-words text-xs text-slate-500">{item.note || 'No item note recorded.'}</p></div>)}</div>}</article>; })}</div>
    <div className="hidden overflow-x-auto xl:block"><table className="w-full min-w-[960px] table-fixed text-left text-sm"><colgroup><col className="w-[16%]" /><col className="w-[33%]" /><col className="w-[21%]" /><col className="w-[30%]" /></colgroup><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Delivered</th><th className="px-3 py-3">Order / client</th><th className="px-3 py-3">Branch</th><th className="px-3 py-3">Items</th></tr></thead><tbody>{pageOrders.map((order) => { const expanded = expandedIds.has(order.id); return <Fragment key={order.id}><tr className="cursor-pointer border-t align-middle hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => toggle(order.id)}><td className="px-3 py-3 text-xs text-slate-500">{order.releasedDate}<br />{order.releasedTime}</td><td className="px-3 py-3"><span className="block font-semibold">{order.orderNumber}</span><span className="mt-0.5 block break-words text-xs text-slate-500">{order.customer}</span></td><td className="px-3 py-3"><BranchBadge branch={order.branch} /></td><td className="px-3 py-3"><div className="flex flex-wrap items-center gap-2"><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Delivered</Badge><Button type="button" variant="outline" size="sm" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); toggle(order.id); }}>{expanded ? 'Hide items' : `View ${order.items.length} items`}</Button></div></td></tr>{expanded && <tr className="border-t bg-slate-50 dark:border-slate-800 dark:bg-slate-900"><td colSpan={4} className="px-4 py-4"><div className="mb-3 text-xs text-slate-500">Customer ID: {order.customerNumber} ? Released by desktop staff ? Read only</div><div className="overflow-hidden rounded-lg border dark:border-slate-800"><table className="w-full text-left text-sm"><thead className="bg-white text-xs uppercase text-slate-500 dark:bg-slate-950"><tr><th className="px-3 py-2">Item</th><th className="w-24 px-3 py-2">Qty</th><th className="w-32 px-3 py-2">Status</th><th className="px-3 py-2">Item note</th></tr></thead><tbody>{order.items.map((item) => <tr key={item.id} className="border-t dark:border-slate-800"><td className="px-3 py-2 font-medium">{item.name}</td><td className="px-3 py-2">? {item.quantity}</td><td className="px-3 py-2"><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Delivered</Badge></td><td className="px-3 py-2 text-slate-500">{item.note || 'No item note recorded.'}</td></tr>)}</tbody></table></div></td></tr>}</Fragment>; })}</tbody></table></div>
    {!filteredOrders.length && <Card><CardContent className="py-12 text-center text-sm text-slate-500">No delivered orders match these filters.</CardContent></Card>}
    <PaginationControls currentPage={currentPage} pageCount={pageCount} total={filteredOrders.length} pageSize={pageSize} onPageChange={setPage} label="orders" />
  </div>;
}

function ReportsView({ reportPeriod, setReportPeriod, reportFrom, setReportFrom, reportTo, setReportTo, reportSearch, setReportSearch, reportBranch, setReportBranch, branchOptions, rows, onDownloadCsv }: {
  reportPeriod: 'all' | 'today' | 'month' | 'custom';
  setReportPeriod: (value: 'all' | 'today' | 'month' | 'custom') => void;
  reportFrom: string;
  setReportFrom: (value: string) => void;
  reportTo: string;
  setReportTo: (value: string) => void;
  reportSearch: string;
  setReportSearch: (value: string) => void;
  reportBranch: string;
  setReportBranch: (value: string) => void;
  branchOptions: string[];
  rows: ({ id: string; name: string; quantity: number; note: string; readyAt?: string; readyAtTime?: string; order: WorkOrder })[];
  onDownloadCsv: () => void;
}) {
  const [page, setPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const pageSize = 20;
  useEffect(() => { setPage(1); setExpandedRows(new Set()); }, [reportPeriod, reportFrom, reportTo, reportSearch, reportBranch]);
  const toggleRow = (id: string) => setExpandedRows((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const periodLabel = reportPeriod === 'all' ? 'All time' : reportPeriod === 'today' ? 'Today' : reportPeriod === 'month' ? 'This month' : `${reportFrom} to ${reportTo}`;
  return <div className="space-y-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><Badge variant="outline" className="mb-2"><FileText className="mr-1 h-3 w-3" />Operations report</Badge><h1 className="text-2xl font-bold">Ready items report</h1><p className="mt-1 text-sm text-slate-500">Each row is an item line marked ready, with its quantity, order, customer, and branch.</p></div><div className="grid grid-cols-2 gap-2 print:hidden"><Button variant="outline" className="px-2 text-xs sm:px-4 sm:text-sm" onClick={() => window.print()}><FileText className="mr-1 h-4 w-4 sm:mr-2" />Save as PDF</Button><Button className="px-2 text-xs sm:px-4 sm:text-sm" onClick={onDownloadCsv}><Download className="mr-1 h-4 w-4 sm:mr-2" />Download CSV</Button></div></div>
    <Card className="print:border-0 print:shadow-none"><CardContent className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap gap-2 print:hidden">{([{ key: 'all', label: 'All time' }, { key: 'today', label: 'Today' }, { key: 'month', label: 'This month' }, { key: 'custom', label: 'Custom dates' }] as const).map((period) => <button key={period.key} onClick={() => setReportPeriod(period.key)} aria-pressed={reportPeriod === period.key} className={`rounded-full px-4 py-2 text-sm font-bold ${reportPeriod === period.key ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>{period.label}</button>)}</div>
      {reportPeriod === 'custom' && <div className="grid gap-3 sm:grid-cols-2 print:hidden"><label className="space-y-1 text-xs text-slate-500">From<Input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></label><label className="space-y-1 text-xs text-slate-500">To<Input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></label></div>}
      <div className="grid gap-2 sm:grid-cols-2 print:hidden"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Filter client, order, item, or branch" /></div><SelectFilter label="Branch" value={reportBranch} onChange={setReportBranch} values={branchOptions} /></div>
      <div className="flex items-center justify-between border-y py-3 dark:border-slate-800"><div><p className="font-semibold">Ready item lines</p><p className="text-xs text-slate-500">{periodLabel} ? {reportBranch}</p></div><Badge variant="secondary">{rows.length} items</Badge></div>
      <div className="space-y-3 xl:hidden">{pageRows.map((row) => {
        const expanded = expandedRows.has(row.id);
        return <article key={row.id} className="overflow-hidden rounded-xl border dark:border-slate-800">
          <button type="button" aria-expanded={expanded} onClick={() => toggleRow(row.id)} className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 sm:p-4">
            <span className="min-w-0"><span className="block break-words font-semibold">{row.name} <span className="font-normal text-slate-500">? {row.quantity}</span></span><span className="mt-1 block font-medium text-slate-700 dark:text-slate-200">{row.order.orderNumber}</span><span className="block break-words text-xs text-slate-500">{row.order.customer}</span><span className="mt-1 block text-xs text-slate-500">Ready {row.readyAt} ? {row.readyAtTime || 'Time unavailable'}</span></span>
            <span className="flex shrink-0 items-center gap-2"><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Ready</Badge><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></span>
          </button>
          {expanded && <div className="grid gap-3 border-t bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2 sm:p-4">
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Order</p><p className="mt-1 font-medium">{row.order.orderNumber}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Customer</p><p className="mt-1 break-words font-medium">{row.order.customer}</p><p className="text-xs text-slate-500">{row.order.customerNumber}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Branch</p><div className="mt-1"><BranchBadge branch={row.order.branch} /></div></div>
            <div className="sm:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Item note</p><p className="mt-1 break-words">{row.note || 'No item note recorded.'}</p></div>
          </div>}
        </article>;
      })}</div>
      <div className="hidden overflow-x-auto xl:block"><table className="w-full min-w-[960px] table-fixed text-left text-sm"><colgroup><col className="w-[16%]" /><col className="w-[21%]" /><col className="w-[33%]" /><col className="w-[7%]" /><col className="w-[13%]" /><col className="w-[10%]" /></colgroup><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Ready date/time</th><th className="px-3 py-3">Item</th><th className="px-3 py-3">Order / client</th><th className="px-3 py-3">Qty</th><th className="px-3 py-3">Branch</th><th className="px-3 py-3">Details</th></tr></thead><tbody>{pageRows.map((row) => {
        const expanded = expandedRows.has(row.id);
        return <Fragment key={row.id}>
          <tr className="cursor-pointer border-t align-middle hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => toggleRow(row.id)}>
            <td className="px-3 py-3 text-xs text-slate-500">{row.readyAt}<br />{row.readyAtTime || 'Time unavailable'}</td>
            <td className="px-3 py-3"><span className="block break-words font-semibold">{row.name}</span></td>
            <td className="px-3 py-3"><span className="block font-semibold">{row.order.orderNumber}</span><span className="mt-0.5 block break-words text-xs text-slate-500">{row.order.customer}</span></td>
            <td className="px-3 py-3 font-medium">? {row.quantity}</td>
            <td className="px-3 py-3"><BranchBadge branch={row.order.branch} /></td>
            <td className="px-3 py-3"><Button type="button" variant="outline" size="sm" aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); toggleRow(row.id); }}>{expanded ? 'Hide details' : 'View details'}</Button></td>
          </tr>
          {expanded && <tr className="border-t bg-slate-50 dark:border-slate-800 dark:bg-slate-900"><td colSpan={6} className="px-4 py-4"><div className="grid gap-4 sm:grid-cols-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Order</p><p className="mt-1 font-medium">{row.order.orderNumber}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Customer</p><p className="mt-1 break-words font-medium">{row.order.customer}</p><p className="text-xs text-slate-500">{row.order.customerNumber}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ready status</p><Badge className="mt-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/50 dark:text-emerald-200">Ready ? {row.quantity} {row.name}</Badge></div><div className="sm:col-span-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Item note</p><p className="mt-1 break-words">{row.note || 'No item note recorded.'}</p></div></div></td></tr>}
        </Fragment>;
      })}</tbody></table></div>
      {!rows.length && <p className="py-8 text-center text-sm text-slate-500">No ready items match this report period and filter.</p>}
      <PaginationControls currentPage={currentPage} pageCount={pageCount} total={rows.length} pageSize={pageSize} onPageChange={setPage} label="items" />
      <p className="hidden text-xs text-slate-500 print:block">Soth Dry Cleaners ? Operations sample report ? No prices or financial information included</p>
    </CardContent></Card>
    <p className="text-xs text-slate-500 print:hidden">PDF uses your browser?s print dialog (choose ?Save as PDF?). CSV downloads the currently filtered ready item lines.</p>
  </div>;
}

function PaginationControls({ currentPage, pageCount, total, pageSize, onPageChange, label }: {
  currentPage: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  label: string;
}) {
  if (pageCount <= 1) return null;
  const pages = new Set<number>([1, pageCount]);
  for (let value = Math.max(2, currentPage - 1); value <= Math.min(pageCount - 1, currentPage + 1); value += 1) pages.add(value);
  if (currentPage <= 3) [2, 3, 4].forEach((value) => { if (value < pageCount) pages.add(value); });
  if (currentPage >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((value) => { if (value > 1) pages.add(value); });
  const orderedPages = [...pages].sort((a, b) => a - b);
  const pageTokens = orderedPages.flatMap((value, index) => index > 0 && value - orderedPages[index - 1] > 1 ? [`ellipsis-${value}`, value] : [value]);
  return <nav className="flex flex-col justify-between gap-3 border-t pt-4 print:hidden sm:flex-row sm:items-center" aria-label={`${label} pagination`}><p className="text-sm text-slate-500">Showing {(currentPage - 1) * pageSize + 1}?{Math.min(currentPage * pageSize, total)} of {total} {label} ? {pageSize} per page</p><div className="flex flex-wrap items-center gap-1.5"><Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => onPageChange(1)} aria-label="First page">First</Button><Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)}>Previous</Button>{pageTokens.map((token) => typeof token === 'number' ? <Button key={token} variant={token === currentPage ? 'default' : 'outline'} size="sm" aria-current={token === currentPage ? 'page' : undefined} onClick={() => onPageChange(token)}>{token}</Button> : <span key={token} className="px-1 text-slate-400" aria-hidden="true">?</span>)}<Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => onPageChange(currentPage + 1)}>Next</Button><Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => onPageChange(pageCount)} aria-label="Last page">Last</Button></div></nav>;
}

function MessagesView({ messages, orders, messageBranch, branchOptions, onMessageBranchChange, messageOrder, setMessageOrder, messageDraft, setMessageDraft, onSend }: {
  messages: DemoMessage[];
  orders: WorkOrder[];
  messageBranch: string;
  branchOptions: string[];
  onMessageBranchChange: (value: string) => void;
  messageOrder: string;
  setMessageOrder: (value: string) => void;
  messageDraft: string;
  setMessageDraft: (value: string) => void;
  onSend: (event: FormEvent) => void;
}) {
  return (
    <div className="space-y-5">
      <div><Badge variant="outline" className="mb-2"><MessageCircle className="mr-1 h-3 w-3" />Branch communication</Badge><h1 className="text-2xl font-bold">Messages</h1><p className="mt-1 text-sm text-slate-500">Coordinate with receiving desks and attach updates to a specific order.</p></div>
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card><CardContent className="p-4 sm:p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Recent messages</h2><p className="text-xs text-slate-500">Demo conversation across branches</p></div><Badge variant="secondary">{messages.length}</Badge></div><div className="space-y-3">{messages.map((message) => <div key={message.id} className={`max-w-2xl rounded-xl border p-3 ${message.outgoing ? 'ml-auto border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30' : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'}`}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{message.sender}</p><span className="text-xs text-slate-500">{message.time}</span></div><p className="mt-2 text-sm">{message.message}</p><p className="mt-2 text-xs text-slate-500">{message.branch} · {message.orderNumber}</p></div>)}</div></CardContent></Card>
        <Card className="h-fit"><CardContent className="p-4 sm:p-5"><div className="mb-4 flex items-center gap-2"><Send className="h-4 w-4 text-blue-700" /><h2 className="font-semibold">Send update to a desk</h2></div><form className="space-y-3" onSubmit={onSend}><SelectFilter label="Branch" value={messageBranch} onChange={onMessageBranchChange} values={branchOptions} /><label className="block space-y-1 text-xs text-slate-500">Order<select value={messageOrder} onChange={(event) => setMessageOrder(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{orders.filter((order) => order.branch === messageBranch).map((order) => <option key={order.id} value={order.orderNumber}>{order.orderNumber} · {order.customer}</option>)}</select></label><label className="block space-y-1 text-xs text-slate-500">Message<textarea value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} rows={4} placeholder="Share an item update or ask the desk a question" className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" /></label><Button type="submit" className="w-full" disabled={!messageDraft.trim()}><Send className="mr-2 h-4 w-4" />Send demo message</Button></form><p className="mt-3 text-xs text-slate-500">In the live system, messages will notify the selected branch and remain attached to the order.</p></CardContent></Card>
      </div>
    </div>
  );
}

function SelectFilter({ label, value, onChange, values }: { label: string; value: string; onChange: (value: string) => void; values: string[] }) {
  return <label className="relative block"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm text-foreground" aria-label={label}>{values.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /></label>;
}

function QuickLink({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-slate-500">{detail}</span></span><ChevronRight className="h-4 w-4 shrink-0 text-slate-400" /></button>;
}

function StatCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: number; detail: string; tone: 'blue' | 'orange' | 'green' | 'slate' }) {
  const styles = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300',
    orange: 'bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300',
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  };
  return <Card className="border-slate-200 shadow-sm dark:border-slate-800"><CardContent className="p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-500 sm:text-sm">{label}</span><span className={`rounded-lg p-2 ${styles[tone]}`}>{icon}</span></div><p className="mt-2 text-2xl font-bold">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></CardContent></Card>;
}

function statusLabel(status: ItemStatus) {
  return status === 'RECEIVED' ? 'Received' : status === 'PROCESSING' ? 'Processing' : 'Ready';
}

export default OperationsDemo;
