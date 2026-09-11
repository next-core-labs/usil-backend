import type { Express, Request, Response } from 'express';
import { clientIp, createSlidingWindowLimiter } from '../shared/booking-guards';
import { createExternalBookingStore, type ExternalBooking } from './external-bookings';
import { isVendorSupervisor } from '../auth/roles';

type Actor = { id: string; name: string; role: string };

type AuthApi = {
  userFromRequest: (req: Request) => Actor | null;
};

export type CourierOption = { id: string; name: string; source: 'account' | 'application' };

type Deps = {
  listCourierOptions: () => CourierOption[];
};

const WRITE_LIMIT = 20;
const WRITE_WINDOW_MS = 60_000;

const NEEDS_LOGIN = 'يلزم تسجيل الدخول.';
const NOT_ALLOWED = 'تسجيل الحجوزات الخارجية للمناديب وإدارة يوصل فقط.';

export function registerExternalBookingRoutes(app: Express, auth: AuthApi, dataDir: string, deps: Deps) {
  const store = createExternalBookingStore(dataDir);
  const writeLimiter = createSlidingWindowLimiter(WRITE_LIMIT, WRITE_WINDOW_MS);

  function actorOf(req: Request, res: Response): Actor | null {
    const user = auth.userFromRequest(req);
    if (!user) {
      res.status(401).json({ success: false, error: NEEDS_LOGIN });
      return null;
    }
    if (user.role !== 'courier' && !isVendorSupervisor(user.role)) {
      res.status(403).json({ success: false, error: NOT_ALLOWED });
      return null;
    }
    return user;
  }

  function ownsRow(actor: Actor, row: ExternalBooking): boolean {
    return isVendorSupervisor(actor.role) || row.courierId === actor.id;
  }

  app.get('/api/external-bookings/couriers', (req: Request, res: Response) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    if (actor.role === 'courier') {
      return res.json({ success: true, data: [{ id: actor.id, name: actor.name, source: 'account' }] });
    }
    res.json({ success: true, data: deps.listCourierOptions() });
  });

  app.get('/api/external-bookings', (req: Request, res: Response) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    res.json({ success: true, data: store.listFor(actor) });
  });

  app.post('/api/external-bookings', (req: Request, res: Response) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    if (!writeLimiter.allow(clientIp(req))) {
      return res.status(429).json({ success: false, error: 'تجاوزت حد التسجيل. انتظر دقيقة ثم أعد المحاولة.' });
    }
    const body = req.body || {};
    let courierId = String(body.courierId || '').trim();
    let courierName = String(body.courierName || '').trim();
    if (actor.role === 'courier') {
      courierId = actor.id;
      courierName = actor.name;
    } else {
      const option = deps.listCourierOptions().find((item) => item.id === courierId);
      if (!option) {
        return res.status(400).json({ success: false, error: 'اختر مندوباً معتمداً من القائمة' });
      }
      courierName = option.name;
    }
    try {
      const created = store.create({ ...body, courierId, courierName }, actor.id);
      res.status(201).json({ success: true, booking: created, message: 'تم تسجيل الحجز الخارجي' });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر تسجيل الحجز الخارجي',
      });
    }
  });

  app.patch('/api/external-bookings/:id', (req: Request, res: Response) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    if (!writeLimiter.allow(clientIp(req))) {
      return res.status(429).json({ success: false, error: 'تجاوزت حد التعديل. انتظر دقيقة ثم أعد المحاولة.' });
    }
    const row = store.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'الحجز الخارجي غير موجود' });
    if (!ownsRow(actor, row)) {
      return res.status(403).json({ success: false, error: 'تقدر تعدّل حجوزاتك أنت فقط.' });
    }
    try {
      const updated = store.update(row.id, req.body || {});
      res.json({ success: true, booking: updated });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'تعذر تعديل الحجز الخارجي',
      });
    }
  });

  app.delete('/api/external-bookings/:id', (req: Request, res: Response) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    if (!isVendorSupervisor(actor.role)) {
      return res.status(403).json({ success: false, error: 'حذف الحجوزات الخارجية لإدارة يوصل فقط.' });
    }
    if (!store.remove(req.params.id)) {
      return res.status(404).json({ success: false, error: 'الحجز الخارجي غير موجود' });
    }
    res.json({ success: true });
  });

  return store;
}
