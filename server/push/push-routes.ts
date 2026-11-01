import type { Express, Request, Response } from 'express';
import { configurePush, hasPushConfig, type PushDirectory } from './push.ts';
import { parsePushRegistration } from './push-store.ts';

type AuthApi = {
  userFromRequest: (req: Request) => { id: string } | null;
};

const NEEDS_LOGIN = 'يلزم تسجيل الدخول.';
const BAD_TOKEN = 'بيانات الجهاز غير صالحة.';

/**
 * The consoles' Firebase web config, so it is set once on the backend rather
 * than baked into each console's build. None of it is secret: Firebase web
 * keys only identify the project, and the VAPID key is the public half.
 *
 * FIREBASE_WEB_CONFIG is the `firebaseConfig` object from Firebase console →
 * Project settings → Your apps → Web app; FIREBASE_VAPID_KEY is Cloud
 * Messaging → Web Push certificates → Key pair.
 */
export function webPushConfig(env: NodeJS.ProcessEnv = process.env) {
  const vapidKey = String(env.FIREBASE_VAPID_KEY || '').trim();
  let firebase: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(String(env.FIREBASE_WEB_CONFIG || '')) as Record<string, unknown>;
    const pick = (key: string) => (typeof parsed[key] === 'string' ? (parsed[key] as string) : '');
    if (pick('apiKey') && pick('projectId') && pick('messagingSenderId') && pick('appId')) {
      firebase = {
        apiKey: pick('apiKey'),
        authDomain: pick('authDomain'),
        projectId: pick('projectId'),
        messagingSenderId: pick('messagingSenderId'),
        appId: pick('appId'),
      };
    }
  } catch {
    /* unset or not JSON: web push stays off */
  }
  return firebase && vapidKey ? { firebase, vapidKey } : null;
}

export function registerPushRoutes(app: Express, auth: AuthApi, dataDir: string, directory: PushDirectory) {
  const store = configurePush(dataDir, directory);

  // Public: the consoles ask before showing «تفعيل الإشعارات».
  app.get('/api/push/config', (_req: Request, res: Response) => {
    const web = hasPushConfig() ? webPushConfig() : null;
    res.json({ success: true, enabled: hasPushConfig(), web });
  });

  app.post('/api/push/register', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    const input = parsePushRegistration(req.body);
    if (!input) return res.status(400).json({ success: false, error: BAD_TOKEN });
    store.register(user.id, input);
    res.json({ success: true });
  });

  // Called just before logout, while the session still names the token's owner.
  app.post('/api/push/unregister', (req: Request, res: Response) => {
    const user = auth.userFromRequest(req);
    if (!user) return res.status(401).json({ success: false, error: NEEDS_LOGIN });
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ success: false, error: BAD_TOKEN });
    store.unregister(user.id, token);
    res.json({ success: true });
  });

  return store;
}
