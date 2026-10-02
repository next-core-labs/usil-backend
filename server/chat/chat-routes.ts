import type { Express, Request, Response } from 'express';
import {
  ChatStoreError,
  createChatStore,
  parseChatContext,
  sideForRole,
  validateChatBody,
  type ChatViewer,
} from './chat-store.ts';
import { createSlidingWindowLimiter } from '../shared/booking-guards.ts';

type ChatUser = { id: string; role: string; name?: string };

type AuthApi = {
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

export type ChatRouteDeps = {
  /** A public (approved) vendor and the name the storefront shows for it, or null. */
  findVendor: (vendorId: string) => { id: string; name: string } | null;
};

/** Generous for a live conversation, tight enough to stop a script flooding a thread. */
const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW_MS = 60 * 1000;
/** A client opening threads with many vendors in a row is the spam pattern. */
const NEW_THREAD_LIMIT = 20;
const NEW_THREAD_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMITED = 'أرسلت رسائل كثيرة. انتظر قليلاً ثم أعد المحاولة.';

function userOf(req: Request): ChatUser {
  return (req as Request & { user: ChatUser }).user;
}

export function registerChatRoutes(app: Express, auth: AuthApi, dataDir: string, deps: ChatRouteDeps) {
  const store = createChatStore(dataDir);
  const messageLimiter = createSlidingWindowLimiter(MESSAGE_LIMIT, MESSAGE_WINDOW_MS);
  const threadLimiter = createSlidingWindowLimiter(NEW_THREAD_LIMIT, NEW_THREAD_WINDOW_MS);
  // accounts_manager passes as admin (see roleAllowed); couriers have no chat.
  const guard = auth.requireRole(['client', 'vendor', 'admin']);

  function viewerOf(req: Request, res: Response): ChatViewer | null {
    const user = userOf(req);
    const side = sideForRole(user?.role);
    if (!user || !side) {
      res.status(403).json({ success: false, error: 'المحادثات غير متاحة لهذا الحساب.' });
      return null;
    }
    return { side, userId: user.id };
  }

  /** The name this side signs with. Vendors sign with their project name. */
  function senderName(req: Request, viewer: ChatViewer): string {
    const user = userOf(req);
    if (viewer.side === 'vendor') return deps.findVendor(user.id)?.name || user.name || 'مورّد';
    return user.name || (viewer.side === 'owner' ? 'فريق يوصل' : 'عميل');
  }

  function fail(res: Response, error: unknown) {
    if (error instanceof ChatStoreError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    throw error;
  }

  app.get('/api/chats', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    res.json({ success: true, data: store.list(viewer) });
  });

  /** Cheap enough to poll for the nav badge. */
  app.get('/api/chats/unread', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    res.json({ success: true, data: { count: store.unreadCount(viewer) } });
  });

  /**
   * Start a thread with its first message, or add to the pair's existing one.
   * A thread never exists without a message, so nobody sees empty rows.
   * - client: `{ vendorId, body }` → their thread with that vendor
   * - vendor: `{ body }` → their thread with the Usil team
   * - owner:  `{ vendorId, body }` → the Usil team's thread with that vendor
   */
  app.post('/api/chats', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    const user = userOf(req);
    const parsed = validateChatBody(req.body?.body);
    if (parsed.ok === false) return res.status(400).json({ success: false, error: parsed.error });

    const vendorId = viewer.side === 'vendor' ? user.id : String(req.body?.vendorId || '').trim();
    const vendor = vendorId ? deps.findVendor(vendorId) : null;
    if (!vendor) return res.status(404).json({ success: false, error: 'المورّد غير موجود.' });

    const pair =
      viewer.side === 'client'
        ? ({
            kind: 'client_vendor',
            vendorId: vendor.id,
            vendorName: vendor.name,
            clientId: user.id,
            clientName: user.name || 'عميل',
          } as const)
        : ({ kind: 'vendor_owner', vendorId: vendor.id, vendorName: vendor.name } as const);

    if (viewer.side === 'client' && !store.hasPair(pair) && !threadLimiter.allow(`chat-thread:${user.id}`)) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }
    if (!messageLimiter.allow(`chat-msg:${user.id}`)) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }

    const { conversation, created } = store.open(pair);
    try {
      store.send(conversation.id, viewer, {
        senderName: senderName(req, viewer),
        body: parsed.value,
        context: parseChatContext(req.body?.context),
      });
      res.status(created ? 201 : 200).json({ success: true, data: store.get(conversation.id, viewer) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/chats/:id', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    try {
      res.json({ success: true, data: store.get(String(req.params.id), viewer, after) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/chats/:id/messages', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    const parsed = validateChatBody(req.body?.body);
    if (parsed.ok === false) return res.status(400).json({ success: false, error: parsed.error });
    if (!messageLimiter.allow(`chat-msg:${viewer.userId}`)) {
      return res.status(429).json({ success: false, error: RATE_LIMITED });
    }
    try {
      const message = store.send(String(req.params.id), viewer, {
        senderName: senderName(req, viewer),
        body: parsed.value,
        context: parseChatContext(req.body?.context),
      });
      res.status(201).json({ success: true, data: message });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/chats/:id/read', guard, (req: Request, res: Response) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    try {
      store.markRead(String(req.params.id), viewer);
      res.json({ success: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return store;
}
