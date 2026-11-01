/**
 * The push twin of each transactional email in shared/optional-mail.ts: one
 * line a lock screen can show, and where a tap should land.
 *
 * Vendors and the owner act in their consoles. The store's native app also
 * hears vendor notices — a vendor's phone is often the app — and hands the
 * tap to the console in the browser, as «لوحة المورّد» in the app already does.
 */
import { vendorConsoleOrdersUrl } from '../shared/optional-mail.ts';
import { pushToEmail, pushToStaff, pushToUser } from './push.ts';

function vendorConsole(route: string): { vendor: string; store: string } {
  return { vendor: `/#/${route}`, store: vendorConsoleOrdersUrl().replace(/#\/orders$/, `#/${route}`) };
}

function withService(bookingId: string, serviceName?: string): string {
  return serviceName ? `${bookingId} — ${serviceName}` : bookingId;
}

/** A client is reached by their account when the order has one, else by its email. */
type Client = { userId?: string; email?: string };

function pushToClient(client: Client, notice: Parameters<typeof pushToUser>[1]) {
  if (client.userId) pushToUser(client.userId, notice);
  else pushToEmail(client.email, notice);
}

export function pushBookingApproved(client: Client, bookingId: string, serviceName: string): void {
  pushToClient(client, {
    title: 'وافق المورّد على طلبك',
    body: `طلبك ${withService(bookingId, serviceName)}. أكمل الدفع لتثبيت الحجز.`,
    links: { store: '/orders' },
  });
}

export function pushBookingCancelled(client: Client, bookingId: string, serviceName: string): void {
  pushToClient(client, {
    title: 'تحديث على طلبك',
    body: `تعذّر تنفيذ طلبك ${withService(bookingId, serviceName)}، وأُلغي الطلب.`,
    links: { store: '/orders' },
  });
}

export function pushVendorNewOrder(vendorId: string, bookingId: string, serviceName: string, needsApproval: boolean): void {
  pushToUser(vendorId, {
    title: needsApproval ? 'طلب جديد بانتظار موافقتك' : 'طلب جديد مدفوع',
    body: needsApproval
      ? `${withService(bookingId, serviceName)} — اقبله أو ارفضه من «طلبات المتجر».`
      : `${withService(bookingId, serviceName)} — دفعه العميل وتأكد.`,
    links: vendorConsole('orders'),
  });
}

export function pushPayoutDecision(
  vendorId: string,
  input: { id: string; amount: number; status: 'approved' | 'paid' | 'rejected' },
): void {
  const amount = `${input.amount.toFixed(2)} ر.س`;
  pushToUser(vendorId, {
    title:
      input.status === 'approved' ? 'تم اعتماد طلب السحب' : input.status === 'paid' ? 'تم تحويل أرباحك' : 'تحديث على طلب السحب',
    body:
      input.status === 'approved'
        ? `اعتمدت الإدارة سحب ${amount}، ويُحوَّل إلى حسابك البنكي.`
        : input.status === 'paid'
          ? `حُوِّل ${amount} إلى حسابك البنكي.`
          : `لم يُعتمد سحب ${amount}، وعاد المبلغ إلى رصيدك.`,
    links: vendorConsole('earnings'),
  });
}

export function pushContractSigned(vendorId: string, input: { number: string; signedByName: string }): void {
  pushToUser(vendorId, {
    title: `وقّع العميل العقد ${input.number}`,
    body: `${input.signedByName || 'العميل'} وقّع العقد إلكترونياً.`,
    links: vendorConsole('contracts'),
  });
}

export function pushVendorBankChanged(vendorId: string): void {
  pushToUser(vendorId, {
    title: 'تم تعديل بياناتك البنكية',
    body: 'عدّلت إدارة يوصل الآيبان أو البنك في ملفك. إذا ما طلبت هذا التعديل تواصل معنا فوراً.',
    links: vendorConsole('storefront'),
  });
}

export function pushPayLinkPaid(
  vendorId: string,
  input: { kind: 'invoice' | 'quotation'; docNumber: string; clientName: string; amount: number },
): void {
  const amount = `${input.amount.toFixed(2)} ر.س`;
  pushToUser(vendorId, {
    title: input.kind === 'invoice' ? `دُفعت الفاتورة ${input.docNumber}` : `دُفع عربون العرض ${input.docNumber}`,
    body: `${input.clientName || 'العميل'} دفع ${amount} عبر رابط الدفع، والمبلغ في رصيدك.`,
    links: vendorConsole(input.kind === 'invoice' ? 'invoices' : 'quotations'),
  });
}

export function pushVendorApplicationDecision(email: string, projectName: string, status: 'approved' | 'rejected'): void {
  const name = projectName || 'متجرك';
  pushToEmail(email, {
    title: status === 'approved' ? 'تم اعتماد متجرك' : 'تحديث على طلب انضمامك',
    body: status === 'approved' ? `مبروك! «${name}» صار مورّداً في يوصل.` : `لم يُعتمد طلب «${name}». عدّل بياناتك وأعد الإرسال.`,
    links: vendorConsole('overview'),
  });
}

export function pushStaffVendorApplication(projectName: string): void {
  pushToStaff({
    title: 'طلب انضمام مورّد جديد',
    body: `«${projectName || 'مورّد'}» ينتظر المراجعة.`,
    links: { owner: '/#/vendor-applications' },
  });
}

export function pushStaffPayoutRequested(vendorName: string, amount: number): void {
  pushToStaff({
    title: 'طلب سحب أرباح جديد',
    body: `«${vendorName || 'مورّد'}» طلب سحب ${amount.toFixed(2)} ر.س.`,
    links: { owner: '/#/payouts' },
  });
}

export function pushStaffNewOrder(bookingId: string, serviceName: string, totalAmount: number, paid: boolean): void {
  pushToStaff({
    title: paid ? 'طلب جديد مدفوع' : 'طلب جديد بانتظار المورّد',
    body: `${withService(bookingId, serviceName)} — ${Number(totalAmount || 0).toFixed(2)} ر.س`,
    links: { owner: '/#/bookings' },
  });
}
