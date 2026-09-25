import type { Express, Request, Response } from 'express';
import { dataUrlProblem, saveUpload, uploadPrefixForPurpose, UPLOAD_MAX_BYTES } from './avatar.ts';

/**
 * HTTP surface for identity. The handlers themselves live in `auth.ts` — this
 * module only binds them to routes, so the wiring stays in one readable place
 * instead of spreading across the composition root.
 */

/** Handlers `return res.json(...)`, so their result is ignored, not `void`. */
type RouteHandler = (req: Request, res: Response) => unknown;

type AuthApi = {
  loginHandler: RouteHandler;
  registerHandler: RouteHandler;
  forgotPasswordHandler: RouteHandler;
  resetPasswordHandler: RouteHandler;
  verifyEmailHandler: RouteHandler;
  verifyEmailTokenHandler: RouteHandler;
  resendVerificationHandler: RouteHandler;
  meHandler: RouteHandler;
  logoutHandler: RouteHandler;
  avatarHandler: RouteHandler;
  listUsersHandler: RouteHandler;
  createUserHandler: RouteHandler;
  updateUserHandler: RouteHandler;
  deleteUserHandler: RouteHandler;
  requireRole: (roles: Array<'client' | 'vendor' | 'admin'>) => (
    req: Request,
    res: Response,
    next: () => void,
  ) => void;
};

const UPLOAD_TOO_LARGE = 'حجم الصورة كبير — الحد الأقصى 5 ميغابايت.';
const UPLOAD_BAD_FORMAT = 'الصيغة غير مدعومة — ارفع صورة jpg أو png أو webp.';


export function registerAuthRoutes(app: Express, auth: AuthApi, dataDir: string) {
  app.post('/api/auth/login', (req, res) => auth.loginHandler(req, res));
  app.post('/api/auth/register', (req, res) => auth.registerHandler(req, res));
  app.post('/api/auth/forgot-password', (req, res) => auth.forgotPasswordHandler(req, res));
  app.post('/api/auth/reset-password', (req, res) => auth.resetPasswordHandler(req, res));
  app.post('/api/auth/verify-email', (req, res) => auth.verifyEmailHandler(req, res));
  app.get('/api/auth/verify-email', (req, res) => auth.verifyEmailTokenHandler(req, res));
  app.post('/api/auth/resend-verification', (req, res) => auth.resendVerificationHandler(req, res));
  app.get('/api/auth/me', (req, res) => auth.meHandler(req, res));
  app.post('/api/auth/logout', (req, res) => auth.logoutHandler(req, res));
  app.post('/api/auth/avatar', (req, res) => auth.avatarHandler(req, res));

  app.get('/api/admin/users', (req, res) => auth.listUsersHandler(req, res));
  app.post('/api/admin/users', (req, res) => auth.createUserHandler(req, res));
  app.patch('/api/admin/users/:id', (req, res) => auth.updateUserHandler(req, res));
  app.delete('/api/admin/users/:id', (req, res) => auth.deleteUserHandler(req, res));

  app.post(
    '/api/uploads',
    auth.requireRole(['client', 'vendor', 'admin']),
    (req: Request, res: Response) => {
      const dataUrl = String(req.body?.dataUrl || '');
      // `purpose` (or the older `prefix` field) only selects from a fixed allowlist.
      const prefix = uploadPrefixForPurpose(req.body?.purpose ?? req.body?.prefix);
      const saved = saveUpload(dataDir, prefix, dataUrl, UPLOAD_MAX_BYTES);
      if (!saved) {
        const problem = dataUrlProblem(dataUrl, UPLOAD_MAX_BYTES);
        return res.status(400).json({
          success: false,
          error: problem === 'size' ? UPLOAD_TOO_LARGE : UPLOAD_BAD_FORMAT,
        });
      }
      res.status(201).json({ success: true, url: saved });
    },
  );
}
