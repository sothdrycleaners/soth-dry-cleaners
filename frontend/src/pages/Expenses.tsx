import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { formatUGX } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { MainLayout } from '@/components/layout/MainLayout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, DollarSign, Check, X, Eye, Calendar, Filter, Clock, Trash2, Loader2, FileDown, Printer, Pencil } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface Expense {
  id: number;
  expense_date: string;
  category_name: string;
  category_color: string;
  description: string;
  amount: string;
  payment_method: string;
  receipt_number: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  recorded_by_name: string;
  approved_by_name: string;
  rejected_by_name?: string;
  rejection_reason?: string | null;
  created_at: string;
  branch_id?: number | null;
  branch_name?: string | null;
  submitted_by?: number;
}

interface Category {
  id: number;
  name: string;
  description: string;
  color: string;
  is_active: boolean;
}

// Helpers for timezone-safe YYYY-MM and YYYY-MM-DD strings
const getLocalDateString = (date: Date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatExpenseDate = (value?: string | null) => {
  if (!value) return '—';
  const dateOnly = String(value).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const parsed = dateOnly
    ? new Date(`${dateOnly}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-UG', { timeZone: 'Africa/Kampala' });
};

const fetchAllExpenseRows = async (token: string, filters: Record<string, string>) => {
  const pageSize = 500;
  const headers = { Authorization: `Bearer ${token}` };
  const first = await axios.get(`${API_BASE_URL}/expenses`, {
    headers,
    params: { ...filters, page: 1, limit: pageSize },
  });
  const rows: Expense[] = first.data.expenses || [];
  const totalPages = Number(first.data.pagination?.totalPages) || 1;
  for (let page = 2; page <= totalPages; page += 1) {
    const response = await axios.get(`${API_BASE_URL}/expenses`, {
      headers,
      params: { ...filters, page, limit: pageSize },
    });
    rows.push(...(response.data.expenses || []));
  }
  return rows;
};

const getMonthBoundaries = (monthString: string) => {
  const [yearStr, monthStr] = monthString.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  
  const firstDay = `${yearStr}-${monthStr}-01`;
  const lastDayNum = new Date(year, month, 0).getDate();
  const lastDay = `${yearStr}-${monthStr}-${String(lastDayNum).padStart(2, '0')}`;
  
  return { firstDay, lastDay };
};

const Expenses = () => {

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [managedCategories, setManagedCategories] = useState<Category[]>([]);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryDraft, setCategoryDraft] = useState({ name: '', description: '', color: '#3B82F6' });
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [categoryDeleting, setCategoryDeleting] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [pendingRejection, setPendingRejection] = useState<number | null>(null);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const exportReportRef = useRef(false);
  const submittingRef = useRef(false);
  const expenseActionRef = useRef(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [monthlyStats, setMonthlyStats] = useState({ total: 0, count: 0, pending: 0 });
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'month' | 'custom'>('all');

  const [filters, setFilters] = useState({
    from_date: '',
    to_date: '',
    category: '',
    status: '',
    search: '',
    branch_id: '',
  });

  const applyDatePreset = (preset: 'all' | 'today' | 'month') => {
    setDatePreset(preset);
    setCurrentPage(1);
    if (preset === 'all') {
      setFilters((prev) => ({ ...prev, from_date: '', to_date: '' }));
      return;
    }
    if (preset === 'today') {
      const today = getLocalDateString();
      setFilters((prev) => ({ ...prev, from_date: today, to_date: today }));
      return;
    }
    const { firstDay, lastDay } = getMonthBoundaries(getLocalDateString().slice(0, 7));
    setFilters((prev) => ({ ...prev, from_date: firstDay, to_date: lastDay }));
  };

  const [actionLoading, setActionLoading] = useState<{
    id: number;
    action: 'APPROVED' | 'REJECTED' | 'DELETE';
  } | null>(null);

  const [formData, setFormData] = useState({
    expense_date: getLocalDateString(),
    historical_entry: false,
    category: '',
    description: '',
    amount: '',
    payment_method: 'CASH',
    receipt_number: '',
    branch_id: '',
  });

  const { token, user, isAdmin, isManager } = useAuth();
  const canChooseBranch = isAdmin || isManager;
  const defaultExpenseBranchId = () => {
    const activeBranches = branches.filter((branch) => branch.is_active !== false);
    const assigned = activeBranches.find((branch) => branch.id === Number(user?.branch_id));
    const defaultBranch = activeBranches.find((branch) => branch.is_default);
    return String(assigned?.id ?? defaultBranch?.id ?? activeBranches[0]?.id ?? '');
  };
  const [branches, setBranches] = useState<Array<{ id: number; name: string; color?: string; is_active?: boolean; is_default?: boolean }>>([]);

  const getBranchColor = (expense: Expense) => {
    const branch = branches.find((item) => expense.branch_id && Number(item.id) === Number(expense.branch_id))
      || branches.find((item) => item.name.trim().toLowerCase() === String(expense.branch_name || '').trim().toLowerCase());
    return branch?.color && /^#[0-9A-Fa-f]{6}$/.test(branch.color) ? branch.color : '#3B82F6';
  };

  const fetchExpenses = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([_, v]) => v !== '')
      );

      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: '40',
        ...activeFilters,
      });

      const response = await axios.get(`${API_BASE_URL}/expenses?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setExpenses(response.data.expenses || []);
      setTotalPages(response.data.pagination?.totalPages || 1);
    } catch (error: unknown) {
      console.error('Failed to fetch expenses:', error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        toast.error('Session expired. Please login again.');
        return;
      }
      toast.error('Failed to load expenses');
    } finally {
      setLoading(false);
    }
  }, [currentPage, filters, token]);

  const fetchCategories = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get(`${API_BASE_URL}/expenses/categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setCategories((response.data || []).filter((category: Category) => category.is_active));
    } catch (error) {
      console.error('Failed to fetch categories:', error);
    }
  }, [token]);

  const fetchManagedCategories = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      const response = await axios.get(`${API_BASE_URL}/expenses/categories?include_inactive=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setManagedCategories(response.data || []);
    } catch (error) {
      console.error('Failed to fetch expense categories for management:', error);
      toast.error('Could not load expense categories');
    }
  }, [isAdmin, token]);

  const resetCategoryDraft = () => {
    setEditingCategory(null);
    setCategoryDraft({ name: '', description: '', color: '#3B82F6' });
  };

  const handleCategorySave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || !categoryDraft.name.trim() || categorySaving) return;
    try {
      setCategorySaving(true);
      const payload = { ...categoryDraft, name: categoryDraft.name.trim(), description: categoryDraft.description.trim() };
      const response = editingCategory
        ? await axios.put(`${API_BASE_URL}/expenses/categories/${editingCategory.id}`, payload, { headers: { Authorization: `Bearer ${token}` } })
        : await axios.post(`${API_BASE_URL}/expenses/categories`, payload, { headers: { Authorization: `Bearer ${token}` } });
      toast.success(response.data.message || (editingCategory ? 'Category updated' : 'Category added'));
      resetCategoryDraft();
      await Promise.all([fetchCategories(), fetchManagedCategories()]);
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(message || 'Could not save expense category');
    } finally {
      setCategorySaving(false);
    }
  };

  const handleCategoryDelete = async () => {
    if (!token || !categoryToDelete || categoryDeleting) return;
    try {
      setCategoryDeleting(true);
      const response = await axios.delete(`${API_BASE_URL}/expenses/categories/${categoryToDelete.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success(response.data.message || 'Category removed');
      if (filters.category === categoryToDelete.name) {
        setFilters((current) => ({ ...current, category: '' }));
      }
      setCategoryToDelete(null);
      resetCategoryDraft();
      await Promise.all([fetchCategories(), fetchManagedCategories()]);
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(message || 'Could not remove expense category');
    } finally {
      setCategoryDeleting(false);
    }
  };

  const handleRestoreCategory = async (category: Category) => {
    if (!token || categorySaving) return;
    try {
      setCategorySaving(true);
      await axios.put(`${API_BASE_URL}/expenses/categories/${category.id}`, {
        name: category.name,
        description: category.description || '',
        color: category.color || '#3B82F6',
        is_active: true,
      }, { headers: { Authorization: `Bearer ${token}` } });
      toast.success(`${category.name} is available for new expenses again`);
      await Promise.all([fetchCategories(), fetchManagedCategories()]);
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(message || 'Could not restore expense category');
    } finally {
      setCategorySaving(false);
    }
  };

  const fetchMonthlyStats = useCallback(async () => {
    if (!token) return;
    try {
      const allExpenses = await fetchAllExpenseRows(token, {
        ...(filters.from_date ? { from_date: filters.from_date } : {}),
        ...(filters.to_date ? { to_date: filters.to_date } : {}),
        ...(filters.branch_id ? { branch_id: filters.branch_id } : {}),
      });
      const approved = allExpenses.filter((e) => e.status === 'APPROVED');
      const pending = allExpenses.filter((e) => e.status === 'PENDING');

      setMonthlyStats({
        total: approved.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0),
        count: approved.length,
        pending: pending.length,
      });
    } catch (error) {
      console.error('Failed to fetch monthly stats:', error);
    }
  }, [token, filters.from_date, filters.to_date, filters.branch_id]);

  useEffect(() => {
    if (!token) return;
    axios
      .get(`${API_BASE_URL}/branches`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => setBranches(res.data.branches || []))
      .catch(() => setBranches([]));
  }, [token]);

  useEffect(() => {
    fetchExpenses();
    fetchCategories();
    fetchMonthlyStats();
  }, [fetchExpenses, fetchCategories, fetchMonthlyStats]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || submittingRef.current) return;
    if (!editingExpense && !formData.branch_id) {
      toast.error('Assign this expense to an active branch before recording it.');
      return;
    }
    submittingRef.current = true;
    try {
      setSubmitting(true);
      if (editingExpense) {
        await axios.put(API_BASE_URL + '/expenses/' + editingExpense.id, formData, {
          headers: { Authorization: 'Bearer ' + token },
        });
        toast.success('Expense updated successfully');
      } else {
        const response = await axios.post(API_BASE_URL + '/expenses', formData, {
          headers: { Authorization: 'Bearer ' + token },
        });
        toast.success(response.data.message || 'Expense recorded successfully');
      }
      setShowAddDialog(false);
      setShowDetailsDialog(false);
      setSelectedExpense(null);
      setEditingExpense(null);
      setFormData({ expense_date: getLocalDateString(), historical_entry: false, category: '', description: '', amount: '', payment_method: 'CASH', receipt_number: '', branch_id: defaultExpenseBranchId() });
      await Promise.all([fetchExpenses(), fetchMonthlyStats()]);
    } catch (error: unknown) {
      console.error(editingExpense ? 'Failed to update expense:' : 'Failed to record expense:', error);
      const errorMessage = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(errorMessage || (editingExpense ? 'Failed to update expense' : 'Failed to record expense'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const isBusy = (id: number, action?: 'APPROVED' | 'REJECTED' | 'DELETE') =>
    !!actionLoading && actionLoading.id === id && (!action || actionLoading.action === action);

  const canChangeStatus = (expense: Expense, nextStatus: 'APPROVED' | 'REJECTED') =>
    isAdmin && expense.status !== nextStatus;

  const canChangeStatusFromList = (expense: Expense, nextStatus: 'APPROVED' | 'REJECTED') =>
    expense.status === 'PENDING' && canChangeStatus(expense, nextStatus);

  const canEditExpense = (expense: Expense) =>
    isAdmin || (expense.status === 'PENDING' && Number(expense.submitted_by) === Number(user?.id));

  const openExpenseForEdit = (expense: Expense) => {
    setEditingExpense(expense);
    setFormData({
      expense_date: String(expense.expense_date || '').slice(0, 10),
      historical_entry: String(expense.expense_date || '').slice(0, 10) < getLocalDateString(),
      category: expense.category_name,
      description: expense.description,
      amount: String(expense.amount),
      payment_method: expense.payment_method || 'CASH',
      receipt_number: expense.receipt_number || '',
      branch_id: expense.branch_id ? String(expense.branch_id) : '',
    });
    setShowDetailsDialog(false);
    setShowAddDialog(true);
  };

  const requestReject = (id: number) => {
    if (actionLoading) return;
    setPendingRejection(id);
    setShowRejectDialog(true);
  };

  const handleApprove = async (id: number, status: 'APPROVED' | 'REJECTED') => {
    if (!token || expenseActionRef.current) return;
    expenseActionRef.current = true;
    try {
      setActionLoading({ id, action: status });
      const response = await axios.patch(
        `${API_BASE_URL}/expenses/${id}/approve`,
        { approval_status: status },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const updatedExpense = response.data.expense as Partial<Expense>;
      setExpenses((prev) => prev.map((expense) =>
        expense.id === id ? { ...expense, ...updatedExpense, status } : expense
      ));
      toast.success(`Expense ${status.toLowerCase()}`);
      setSelectedExpense((prev) => (prev && prev.id === id
        ? { ...prev, ...updatedExpense, status }
        : prev));
      await Promise.all([fetchExpenses(), fetchMonthlyStats()]);
      if (status === 'REJECTED') setShowRejectDialog(false);
    } catch (error: unknown) {
      console.error('Failed to approve expense:', error);
      const errorMessage = axios.isAxiosError(error) 
        ? error.response?.data?.error 
        : undefined;
      toast.error(errorMessage || 'Failed to approve expense');
    } finally {
      expenseActionRef.current = false;
      setActionLoading(null);
    }
  };

  const handleDelete = async (expense: Expense) => {
    if (!token || !isAdmin || expenseActionRef.current) return;
    const confirmed = window.confirm(
      `Permanently delete this ${expense.status.toLowerCase()} expense of ${formatUGX(expense.amount)}? This cannot be undone.`
    );
    if (!confirmed) return;
    expenseActionRef.current = true;
    try {
      setActionLoading({ id: expense.id, action: 'DELETE' });
      await axios.delete(`${API_BASE_URL}/expenses/${expense.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success('Expense deleted');
      setShowDetailsDialog(false);
      setSelectedExpense(null);
      fetchExpenses();
      fetchMonthlyStats();
    } catch (error: unknown) {
      console.error('Failed to delete expense:', error);
      const errorMessage = axios.isAxiosError(error)
        ? error.response?.data?.error
        : undefined;
      toast.error(errorMessage || 'Failed to delete expense');
    } finally {
      expenseActionRef.current = false;
      setActionLoading(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'APPROVED': return 'bg-green-500 hover:bg-green-600 text-white';
      case 'REJECTED': return 'bg-red-500 hover:bg-red-600 text-white';
      default: return 'bg-yellow-500 hover:bg-yellow-600 text-white';
    }
  };

  const formatPaymentMethod = (method: string) => {
    switch (method) {
      case 'CASH': return 'Cash';
      case 'MTN_MOBILE_MONEY': return 'MTN Mobile Money';
      case 'AIRTEL_MONEY': return 'Airtel Money';
      case 'MOBILE_MONEY': return 'Mobile Money';
      case 'BANK_TRANSFER': return 'Bank Transfer';
      case 'CENTENARY': return 'Centenary Bank';
      case 'CARD': return 'Card / Bancroft';
      default: return method?.replace(/_/g, ' ') || '-';
    }
  };

  const createExpensesPdf = async (printAfter: boolean) => {
    if (!token || exportReportRef.current) return;
    exportReportRef.current = true;
    setExportingReport(true);
    try {
      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value !== '')
      );
      const reportRows = await fetchAllExpenseRows(token, activeFilters);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const from = filters.from_date || 'All dates';
      const to = filters.to_date || 'Present';
      const generated = new Date().toLocaleString('en-UG', { timeZone: 'Africa/Kampala' });
      const approved = reportRows.filter((row) => row.status === 'APPROVED');
      const pending = reportRows.filter((row) => row.status === 'PENDING');
      const approvedTotal = approved.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

      doc.setFontSize(18);
      doc.text('Expense Report', 14, 16);
      doc.setFontSize(10);
      doc.text(`Expense dates: ${from} to ${to}`, 14, 23);
      const appliedFilters = [
        filters.category ? `Category: ${filters.category}` : '',
        filters.status ? `Status: ${filters.status}` : '',
        filters.branch_id ? `Branch: ${branches.find((branch) => String(branch.id) === filters.branch_id)?.name || filters.branch_id}` : '',
        filters.search ? `Search: ${filters.search}` : '',
      ].filter(Boolean);
      if (appliedFilters.length) doc.text(`Filters: ${appliedFilters.join(' | ')}`, 14, 29);
      const generatedY = appliedFilters.length ? 35 : 29;
      doc.text(`Generated: ${generated} (Africa/Kampala)`, 14, generatedY);
      doc.text(`Matching records: ${reportRows.length}   Approved total: ${formatUGX(approvedTotal)}   Pending: ${pending.length}`, 14, generatedY + 6);
      doc.setFontSize(8);
      doc.text('Approved total excludes pending and rejected expenses. Dates show when each expense occurred.', 14, generatedY + 11);

      autoTable(doc, {
        startY: generatedY + 16,
        head: [['Expense Date', 'Category', 'Description', 'Amount (UGX)', 'Method', 'Status', 'Branch', 'Recorded By', 'Receipt']],
        body: reportRows.map((row) => [
          formatExpenseDate(row.expense_date),
          row.category_name || '',
          row.description || '',
          formatUGX(Number(row.amount) || 0),
          formatPaymentMethod(row.payment_method),
          row.status,
          row.branch_name || '—',
          row.recorded_by_name || '',
          row.receipt_number || '—',
        ]),
        styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: [31, 78, 121] },
        columnStyles: { 2: { cellWidth: 48 }, 7: { cellWidth: 28 } },
        margin: { left: 10, right: 10 },
      });

      const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'all';
      const fileName = `expenses-${safePart(from)}-to-${safePart(to)}.pdf`;
      if (printAfter) {
        doc.autoPrint();
        const pdfUrl = URL.createObjectURL(doc.output('blob'));
        const printWindow = window.open(pdfUrl, '_blank');
        if (!printWindow) {
          URL.revokeObjectURL(pdfUrl);
          toast.error('Allow pop-ups to open the printable expense report');
          return;
        }
        window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
      } else {
        doc.save(fileName);
        toast.success('Expense report PDF downloaded');
      }
    } catch (error: unknown) {
      console.error('Failed to export expense report:', error);
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      toast.error(message || 'Failed to create expense report');
    } finally {
      exportReportRef.current = false;
      setExportingReport(false);
    }
  };

  return (
    <MainLayout title="Expenses" subtitle="Record, review, and report business expenses">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 sm:gap-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Date range</span>
          <Button type="button" size="sm" variant={datePreset === 'all' ? 'default' : 'outline'}
            onClick={() => applyDatePreset('all')}>All time</Button>
          <Button type="button" size="sm" variant={datePreset === 'today' ? 'default' : 'outline'}
            onClick={() => applyDatePreset('today')}>Today</Button>
          <Button type="button" size="sm" variant={datePreset === 'month' ? 'default' : 'outline'}
            onClick={() => applyDatePreset('month')}>This month</Button>
          <Button type="button" size="sm" variant={datePreset === 'custom' ? 'default' : 'outline'}
            onClick={() => { setDatePreset('custom'); setCurrentPage(1); }}>Custom dates</Button>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          {isAdmin && (
            <Button
              type="button"
              variant="outline"
              className="gap-2 w-full sm:w-auto"
              onClick={() => {
                setShowCategoryManager(true);
                void fetchManagedCategories();
              }}
            >
              <Pencil className="w-4 h-4" />
              Manage Categories
            </Button>
          )}
          <Button variant="outline" disabled={exportingReport} onClick={() => void createExpensesPdf(false)} className="gap-2">
            {exportingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Export filtered PDF
          </Button>
          <Button variant="outline" disabled={exportingReport} onClick={() => void createExpensesPdf(true)} className="gap-2">
            {exportingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            Print filtered report
          </Button>
          <Button
            onClick={() => {
            setEditingExpense(null);
            setFormData({ expense_date: getLocalDateString(), historical_entry: false, category: '', description: '', amount: '', payment_method: 'CASH', receipt_number: '', branch_id: user?.branch_id ? String(user.branch_id) : '' });
            setShowAddDialog(true);
          }}
          className="gap-2 w-full sm:w-auto"
          >
            <Plus className="w-4 h-4" />
            Record Expense
          </Button>
        </div>
      </div>

      {/* Monthly Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <DollarSign className="w-8 h-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold text-red-600">{formatUGX(monthlyStats.total)}</p>
                <p className="text-sm text-gray-500">{monthlyStats.count} approved expenses</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Pending Approval
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="w-8 h-8 text-yellow-500" />
              <div>
                <p className="text-2xl font-bold text-yellow-600">{monthlyStats.pending}</p>
                <p className="text-sm text-gray-500">awaiting admin review</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Selected Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Calendar className="w-8 h-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">
                  {filters.from_date || filters.to_date
                    ? `${filters.from_date || 'All dates'} to ${filters.to_date || 'Present'}`
                    : 'All time'}
                </p>
                <p className="text-sm text-gray-500">expense history</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="w-5 h-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {datePreset === 'custom' && (
              <>
                <div>
                  <Label>From Date</Label>
                  <Input type="date" value={filters.from_date}
                    onChange={(e) => { setFilters((prev) => ({ ...prev, from_date: e.target.value })); setCurrentPage(1); }} />
                </div>
                <div>
                  <Label>To Date</Label>
                  <Input type="date" value={filters.to_date}
                    onChange={(e) => { setFilters((prev) => ({ ...prev, to_date: e.target.value })); setCurrentPage(1); }} />
                </div>
              </>
            )}
            <div>
              <Label>Category</Label>
              <Select
                value={filters.category || 'all'}
                onValueChange={(val) => {
                  setFilters({ ...filters, category: val === 'all' ? '' : val });
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={filters.status || 'all'}
                onValueChange={(val) => {
                  setFilters({ ...filters, status: val === 'all' ? '' : val });
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {canChooseBranch && branches.length > 1 && (
              <div>
                <Label>Branch</Label>
                <Select
                  value={filters.branch_id || 'all'}
                  onValueChange={(val) => {
                    setFilters({ ...filters, branch_id: val === 'all' ? '' : val });
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Branches" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Branches</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label>Search</Label>
              <Input
                placeholder="Search..."
                value={filters.search}
                onChange={(e) => {
                  setFilters({ ...filters, search: e.target.value });
                  setCurrentPage(1);
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Expenses Table */}
      <Card>
        <CardContent className="p-0">
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1050px]">
              <thead className="bg-gray-50 dark:bg-gray-800 border-b dark:border-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Expense Date</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Category</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Description</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">Amount</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Method</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Branch</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">Recorded By</th>
                  <th className="px-4 py-3 text-center text-sm font-semibold text-gray-900 dark:text-gray-100">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                      Loading...
                    </td>
                  </tr>
                ) : expenses.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                      No expenses found
                    </td>
                  </tr>
                ) : (
                  expenses.map((expense) => (
                    <tr
                      key={expense.id}
                      className="border-b dark:border-gray-700 hover:bg-muted/60 dark:hover:bg-gray-700/50 transition-colors duration-150 cursor-pointer"
                      onClick={() => {
                        setSelectedExpense(expense);
                        setShowDetailsDialog(true);
                      }}
                    >
                      <td className="px-4 py-3 text-sm dark:text-gray-300">
                        {formatExpenseDate(expense.expense_date)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge style={{ backgroundColor: expense.category_color }} className="text-white">
                          {expense.category_name}
                        </Badge>
                      </td>
                      <td className="max-w-[260px] px-4 py-3 text-sm dark:text-gray-300">
                        <span className="block truncate" title={expense.description}>{expense.description || '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-sm dark:text-gray-200">
                        {formatUGX(expense.amount)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs text-muted-foreground">
                          {formatPaymentMethod(expense.payment_method)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={getStatusColor(expense.status)}>{expense.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {expense.branch_name ? (
                          <span title={expense.branch_name} className="inline-block max-w-full truncate rounded-full border px-2 py-0.5 text-xs font-medium" style={{ color: getBranchColor(expense), borderColor: `${getBranchColor(expense)}66`, backgroundColor: `${getBranchColor(expense)}1A` }}>
                            {expense.branch_name}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm dark:text-gray-300">{expense.recorded_by_name}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            title="View details"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedExpense(expense);
                              setShowDetailsDialog(true);
                            }}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {canChangeStatusFromList(expense, 'APPROVED') && (
                              <Button
                                size="sm"
                                className="bg-green-500 hover:bg-green-600 text-white disabled:opacity-50"
                                title="Approve"
                                disabled={!!actionLoading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleApprove(expense.id, 'APPROVED');
                                }}
                              >
                                {isBusy(expense.id, 'APPROVED') ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </Button>
                          )}
                          {canChangeStatusFromList(expense, 'REJECTED') && (
                              <Button
                                size="sm"
                                className="bg-red-500 hover:bg-red-600 text-white disabled:opacity-50"
                                title="Reject"
                                disabled={!!actionLoading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestReject(expense.id);
                                }}
                              >
                                {isBusy(expense.id, 'REJECTED') ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <X className="w-4 h-4" />
                                )}
                              </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 p-3 lg:hidden">
            {loading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading expenses…</div>
            ) : expenses.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No expenses found</div>
            ) : expenses.map((expense) => (
              <article
                key={`mobile-${expense.id}`}
                className="min-w-0 rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-muted/40"
                onClick={() => { setSelectedExpense(expense); setShowDetailsDialog(true); }}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Badge style={{ backgroundColor: expense.category_color }} className="max-w-full truncate text-white">
                      {expense.category_name}
                    </Badge>
                    <p className="mt-1 break-words text-sm font-medium">{formatExpenseDate(expense.expense_date)}</p>
                  </div>
                  <p className="shrink-0 text-right font-semibold">{formatUGX(expense.amount)}</p>
                </div>
                <p className="mt-3 break-words text-sm text-muted-foreground">{expense.description || '—'}</p>
                <div className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t pt-3 text-sm">
                  <div className="min-w-0">
                    <span className="block text-xs text-muted-foreground">Method</span>
                    <span className="block break-words">{formatPaymentMethod(expense.payment_method)}</span>
                  </div>
                  <div className="min-w-0">
                    <span className="block text-xs text-muted-foreground">Status</span>
                    <span className="mt-0.5 block">{getStatusBadge(expense.status)}</span>
                  </div>
                  <div className="min-w-0">
                    <span className="block text-xs text-muted-foreground">Branch</span>
                    {expense.branch_name ? (
                      <span title={expense.branch_name} className="mt-0.5 inline-block max-w-full break-words rounded-full border px-2 py-0.5 text-xs font-medium" style={{ color: getBranchColor(expense), borderColor: `${getBranchColor(expense)}66`, backgroundColor: `${getBranchColor(expense)}1A` }}>{expense.branch_name}</span>
                    ) : <span>—</span>}
                  </div>
                  <div className="min-w-0">
                    <span className="block text-xs text-muted-foreground">Recorded by</span>
                    <span className="block break-words">{expense.recorded_by_name || '—'}</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 border-t pt-2">
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setSelectedExpense(expense); setShowDetailsDialog(true); }}>
                    <Eye className="mr-1.5 h-4 w-4" />Details
                  </Button>
                  {canChangeStatusFromList(expense, 'APPROVED') && (
                    <Button size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={!!actionLoading} onClick={(e) => { e.stopPropagation(); handleApprove(expense.id, 'APPROVED'); }}>
                      {isBusy(expense.id, 'APPROVED') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}Approve
                    </Button>
                  )}
                  {canChangeStatusFromList(expense, 'REJECTED') && (
                    <Button size="sm" variant="destructive" disabled={!!actionLoading} onClick={(e) => { e.stopPropagation(); requestReject(expense.id); }}>
                      {isBusy(expense.id, 'REJECTED') ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="mr-1.5 h-4 w-4" />}Reject
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 p-4 border-t dark:border-gray-700">
              <Button
                variant="outline"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              >
                Previous
              </Button>
              <span className="py-2 px-4 text-sm">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Expense Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => { setShowAddDialog(open); if (!open) setEditingExpense(null); }}>
        <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[96dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>{editingExpense ? 'Edit Expense' : 'Record New Expense'}</DialogTitle>
            <DialogDescription>Record a business expense for admin approval</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Checkbox id="historical-expense" checked={formData.historical_entry}
                    onCheckedChange={(checked) => {
                      const enabled = Boolean(checked);
                      setFormData({ ...formData, historical_entry: enabled,
                        expense_date: enabled ? (() => { const d = new Date(); d.setDate(d.getDate() - 1); return getLocalDateString(d); })() : getLocalDateString() });
                    }} />
                  <Label htmlFor="historical-expense">Record a historical expense</Label>
                </div>
                <Label htmlFor="expense_date">{formData.historical_entry ? 'Expense Date *' : 'Expense Date (today)'}</Label>
                {formData.historical_entry ? <Input id="expense_date" type="date" max={getLocalDateString()}
                  value={formData.expense_date} onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })} required />
                  : <p className="mt-2 text-sm text-muted-foreground">{getLocalDateString()}</p>}
              </div>
              {canChooseBranch && branches.length > 0 && !editingExpense && (
                <div>
                  <Label>Branch *</Label>
                  <Select
                    value={formData.branch_id}
                    onValueChange={(val) => setFormData({ ...formData, branch_id: val })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.filter((branch) => branch.is_active !== false).map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label htmlFor="category">Category *</Label>
                <Select
                  value={formData.category}
                  onValueChange={(val) => setFormData({ ...formData, category: val })}
                  required
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={cat.name}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="amount">Amount (UGX) *</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  required
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea
                  id="description"
                  placeholder="What was this expense for?"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="payment_method">Payment Method</Label>
                <Select
                  value={formData.payment_method}
                  onValueChange={(val) => setFormData({ ...formData, payment_method: val })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">Cash</SelectItem>
                    <SelectItem value="MTN_MOBILE_MONEY">MTN Mobile Money</SelectItem>
                    <SelectItem value="AIRTEL_MONEY">Airtel Money</SelectItem>
                    <SelectItem value="BANK_TRANSFER">Bank Transfer</SelectItem>
                    <SelectItem value="CENTENARY">Centenary Bank</SelectItem>
                    <SelectItem value="CARD">Card / Bancroft</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="receipt_number">Receipt Number</Label>
                <Input
                  id="receipt_number"
                  placeholder="Optional"
                  value={formData.receipt_number}
                  onChange={(e) => setFormData({ ...formData, receipt_number: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAddDialog(false)}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button type="submit" className="w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed" disabled={submitting} aria-busy={submitting}>
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {submitting ? (editingExpense ? 'Saving...' : 'Recording...') : (editingExpense ? 'Save Changes' : 'Record Expense')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Administrator-only expense category management */}
      <Dialog
        open={showCategoryManager}
        onOpenChange={(open) => {
          setShowCategoryManager(open);
          if (!open) resetCategoryDraft();
        }}
      >
        <DialogContent className="max-w-[95vw] sm:max-w-xl max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Manage Expense Categories</DialogTitle>
            <DialogDescription>
              Active categories are available to staff when recording expenses. Categories with expense history are archived on deletion so past records remain intact.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCategorySave} className="space-y-3 rounded-lg border p-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="expense-category-name">Category name *</Label>
                <Input
                  id="expense-category-name"
                  value={categoryDraft.name}
                  maxLength={100}
                  onChange={(event) => setCategoryDraft((draft) => ({ ...draft, name: event.target.value }))}
                  placeholder="e.g. Equipment servicing"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expense-category-color">Color</Label>
                <Input
                  id="expense-category-color"
                  type="color"
                  value={categoryDraft.color}
                  onChange={(event) => setCategoryDraft((draft) => ({ ...draft, color: event.target.value }))}
                  className="h-10 w-full p-1 sm:w-16"
                  aria-label="Category color"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expense-category-description">Description</Label>
              <Textarea
                id="expense-category-description"
                value={categoryDraft.description}
                maxLength={500}
                onChange={(event) => setCategoryDraft((draft) => ({ ...draft, description: event.target.value }))}
                placeholder="Optional guidance for staff"
                rows={2}
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {editingCategory && (
                <Button type="button" variant="outline" onClick={resetCategoryDraft} disabled={categorySaving}>
                  Cancel edit
                </Button>
              )}
              <Button type="submit" disabled={categorySaving || !categoryDraft.name.trim()}>
                {categorySaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingCategory ? 'Save Category' : 'Add Category'}
              </Button>
            </div>
          </form>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Categories</h3>
            {managedCategories.length ? managedCategories.map((category) => (
              <div key={category.id} className="flex items-center gap-3 rounded-lg border p-3">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: category.color || '#3B82F6' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{category.name}</p>
                  {category.description && <p className="line-clamp-2 text-xs text-muted-foreground">{category.description}</p>}
                  {!category.is_active && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Archived · unavailable for new expenses</p>}
                </div>
                {category.is_active ? (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${category.name}`}
                      onClick={() => {
                        setEditingCategory(category);
                        setCategoryDraft({ name: category.name, description: category.description || '', color: category.color || '#3B82F6' });
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${category.name}`}
                      onClick={() => setCategoryToDelete(category)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={categorySaving} onClick={() => void handleRestoreCategory(category)}>
                    Restore
                  </Button>
                )}
              </div>
            )) : (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No expense categories yet. Add one above.</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowCategoryManager(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!categoryToDelete} onOpenChange={(open) => { if (!open && !categoryDeleting) setCategoryToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this expense category?</AlertDialogTitle>
            <AlertDialogDescription>
              {categoryToDelete?.name} will be removed from the choices staff see. If expenses already use it, the category will be archived and kept on those records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={categoryDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={categoryDeleting || !categoryToDelete}
              onClick={(event) => {
                event.preventDefault();
                void handleCategoryDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {categoryDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove category
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Expense Details Dialog */}
      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[96dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Expense Details</DialogTitle>
          </DialogHeader>
          {selectedExpense && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Date</Label>
                  <p className="font-medium">
                    {formatExpenseDate(selectedExpense.expense_date)}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Category</Label>
                  <Badge
                    style={{ backgroundColor: selectedExpense.category_color }}
                    className="text-white mt-1 block w-fit"
                  >
                    {selectedExpense.category_name}
                  </Badge>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Amount</Label>
                  <p className="font-bold text-lg">{formatUGX(selectedExpense.amount)}</p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Payment Method</Label>
                  <p className="font-medium">
                    {formatPaymentMethod(selectedExpense.payment_method)}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Receipt / Ref #</Label>
                  <p className="font-medium">{selectedExpense.receipt_number || '—'}</p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Status</Label>
                  <Badge className={`${getStatusColor(selectedExpense.status)} mt-1 block w-fit`}>
                    {selectedExpense.status}
                  </Badge>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-gray-600 dark:text-gray-400">Description</Label>
                  <p className="mt-1 text-sm leading-relaxed bg-muted/50 rounded p-3 whitespace-pre-wrap dark:bg-gray-800">
                    {selectedExpense.description}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Recorded By</Label>
                  <p className="font-medium">{selectedExpense.recorded_by_name}</p>
                </div>
                <div>
                  <Label className="text-gray-600 dark:text-gray-400">Branch</Label>
                  <p className="font-medium">{selectedExpense.branch_name || '—'}</p>
                </div>
                {selectedExpense.status === 'APPROVED' && selectedExpense.approved_by_name && (
                  <div>
                    <Label className="text-gray-600 dark:text-gray-400">Approved By</Label>
                    <p className="font-medium">{selectedExpense.approved_by_name}</p>
                  </div>
                )}
                {selectedExpense.status === 'REJECTED' && selectedExpense.rejected_by_name && (
                  <div>
                    <Label className="text-gray-600 dark:text-gray-400">Rejected By</Label>
                    <p className="font-medium">{selectedExpense.rejected_by_name}</p>
                  </div>
                )}
                {selectedExpense.status === 'REJECTED' && selectedExpense.rejection_reason && (
                  <div className="sm:col-span-2">
                    <Label className="text-gray-600 dark:text-gray-400">Rejection Reason</Label>
                    <p className="mt-1 text-sm leading-relaxed bg-muted/50 rounded p-3 whitespace-pre-wrap dark:bg-gray-800">
                      {selectedExpense.rejection_reason}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-between">
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              {selectedExpense && canEditExpense(selectedExpense) && (
                <Button variant="outline" className="w-full sm:w-auto" disabled={!!actionLoading} onClick={() => openExpenseForEdit(selectedExpense)}>
                  <Pencil className="w-4 h-4 mr-2" /> Edit Expense
                </Button>
              )}
              {selectedExpense && canChangeStatus(selectedExpense, 'APPROVED') && (
                <Button
                  className="bg-green-500 hover:bg-green-600 text-white w-full sm:w-auto disabled:opacity-50"
                  disabled={!!actionLoading}
                  onClick={() => handleApprove(selectedExpense.id, 'APPROVED')}
                >
                  {isBusy(selectedExpense.id, 'APPROVED') ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4 mr-2" />
                  )}
                  {selectedExpense.status === 'REJECTED' ? 'Approve instead' : 'Approve'}
                </Button>
              )}
              {selectedExpense && canChangeStatus(selectedExpense, 'REJECTED') && (
                <Button
                  className="bg-red-500 hover:bg-red-600 text-white w-full sm:w-auto disabled:opacity-50"
                  disabled={!!actionLoading}
                  onClick={() => requestReject(selectedExpense.id)}
                >
                  {isBusy(selectedExpense.id, 'REJECTED') ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <X className="w-4 h-4 mr-2" />
                  )}
                  {selectedExpense.status === 'APPROVED' ? 'Change to Rejected' : 'Reject'}
                </Button>
              )}
              {isAdmin && selectedExpense?.status === 'REJECTED' && (
                <Button
                  variant="destructive"
                  className="w-full sm:w-auto disabled:opacity-50"
                  disabled={!!actionLoading}
                  onClick={() => handleDelete(selectedExpense)}
                >
                  {isBusy(selectedExpense.id, 'DELETE') ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-2" />
                  )}
                  Delete
                </Button>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => setShowDetailsDialog(false)}
              disabled={!!actionLoading}
              className="w-full sm:w-auto"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showRejectDialog}
        onOpenChange={(open) => {
          setShowRejectDialog(open);
          if (!open) setPendingRejection(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject expense?</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject this expense? The rejection will be recorded and the submitter will be notified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)} disabled={!!actionLoading}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!!actionLoading || pendingRejection === null}
              onClick={() => {
                if (pendingRejection === null) return;
                void handleApprove(pendingRejection, 'REJECTED');
              }}
            >
              {actionLoading?.action === 'REJECTED' ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Rejecting…</>
              ) : 'Reject expense'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
};

export default Expenses;
