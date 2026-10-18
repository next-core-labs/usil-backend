import type { Express, Request, Response } from 'express';
import { normalizeSaudiMobile } from '../shared/booking-guards';
import { createVendorLeadStore, isLeadStatus, LEAD_IMPORT_MAX_ROWS, type LeadInput } from './vendor-leads';

type AuthApi = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (req: Request, res: Response, next: () => void) => void;
  /** Vendor accounts, to mark a lead whose number already sells on Usil. */
  listVendorUsers?: () => Array<{ id: string; phone?: string }>;
};

/**
 * Owner console «أرقام المورّدين»: import a sheet of supplier numbers, then
 * work the list (WhatsApp, status, notes). Admin and accounts manager only.
 */
export function registerVendorLeadRoutes(app: Express, auth: AuthApi, dataDir: string) {
  const store = createVendorLeadStore(dataDir);
  const supervisors = auth.requireRole(['admin']);

  const vendorPhones = (): Set<string> =>
    new Set(
      (auth.listVendorUsers?.() || [])
        .map((user) => normalizeSaudiMobile(String(user.phone || '')))
        .filter((phone): phone is string => Boolean(phone)),
    );

  app.get('/api/admin/vendor-leads', supervisors, (_req: Request, res: Response) => {
    const vendors = vendorPhones();
    res.json({
      success: true,
      data: store.list().map((row) => ({ ...row, alreadyVendor: vendors.has(row.phone) })),
    });
  });

  app.post('/api/admin/vendor-leads/import', supervisors, (req: Request, res: Response) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'الملف ما فيه صفوف. تأكد إن فيه عمود لرقم الجوال.' });
    }
    if (rows.length > LEAD_IMPORT_MAX_ROWS) {
      return res
        .status(413)
        .json({ success: false, error: `الحد ${LEAD_IMPORT_MAX_ROWS} رقم في الملف الواحد. قسّم الملف وارفعه على دفعات.` });
    }
    const safe = rows.map((row: unknown) => (row && typeof row === 'object' && !Array.isArray(row) ? (row as LeadInput) : {}));
    res.json({ success: true, data: store.importRows(safe) });
  });

  app.post('/api/admin/vendor-leads', supervisors, (req: Request, res: Response) => {
    const result = store.addOne(req.body || {});
    if (result.ok === false) return res.status(result.status).json({ success: false, error: result.error });
    res.status(201).json({ success: true, data: result.lead });
  });

  app.patch('/api/admin/vendor-leads/:id', supervisors, (req: Request, res: Response) => {
    if (req.body?.status !== undefined && !isLeadStatus(req.body.status)) {
      return res.status(400).json({ success: false, error: 'الحالة غير صحيحة.' });
    }
    const row = store.update(String(req.params.id || ''), req.body || {});
    if (!row) return res.status(404).json({ success: false, error: 'الرقم غير موجود.' });
    res.json({ success: true, data: row });
  });

  app.delete('/api/admin/vendor-leads/:id', supervisors, (req: Request, res: Response) => {
    if (!store.remove(String(req.params.id || ''))) {
      return res.status(404).json({ success: false, error: 'الرقم غير موجود.' });
    }
    res.json({ success: true });
  });
}
