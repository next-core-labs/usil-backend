export type VendorHubStatus = 'approved' | 'pending' | 'rejected';

export type VendorHubRow = {
  vendorId: string;
  name: string;
  projectName: string;
  email: string;
  status: VendorHubStatus;
  listingCount: number;
  bookingCount: number;
  isOwn: boolean;
};

type HubApplication = {
  id: string;
  email: string;
  firstName?: string;
  familyName?: string;
  projectName?: string;
  status: VendorHubStatus;
};

type HubVendor = {
  id: string;
  name: string;
  email: string;
};

type HubSummary = {
  listingCount?: number;
  bookingCount?: number;
};

function normalizeEmail(raw?: string): string {
  return String(raw || '').trim().toLowerCase();
}

function applicationName(app: HubApplication): string {
  const person = `${app.firstName || ''} ${app.familyName || ''}`.trim();
  return app.projectName || person || app.email;
}

export function pickDefaultVendorHub(
  hubs: VendorHubRow[],
  actor: { id?: string; email?: string } | null | undefined,
): VendorHubRow | null {
  if (!actor || !hubs.length) return null;
  const email = normalizeEmail(actor.email);
  return (
    hubs.find((row) => row.isOwn && actor.id && row.vendorId === actor.id) ||
    hubs.find((row) => row.isOwn && email && row.email === email) ||
    hubs.find((row) => row.isOwn) ||
    null
  );
}

export function buildVendorHubs(input: {
  actor: { id: string; email: string };
  vendors?: HubVendor[];
  applications?: HubApplication[];
  summaries?: Record<string, HubSummary>;
}): VendorHubRow[] {
  const actorEmail = normalizeEmail(input.actor.email);
  const summaries = input.summaries || {};
  const applications = input.applications || [];
  const vendors = input.vendors || [];
  const byEmail = new Map(applications.map((app) => [normalizeEmail(app.email), app]));
  const rows = new Map<string, VendorHubRow>();

  const markOwn = (email: string, vendorId: string) =>
    Boolean((actorEmail && email === actorEmail) || (input.actor.id && vendorId === input.actor.id));

  for (const vendor of vendors) {
    const email = normalizeEmail(vendor.email);
    const app = byEmail.get(email);
    const summary = summaries[vendor.id] || {};
    rows.set(vendor.id, {
      vendorId: vendor.id,
      name: vendor.name || applicationName(app || { id: vendor.id, email, status: 'approved' }),
      projectName: app?.projectName || vendor.name || '',
      email,
      status: app?.status || 'approved',
      listingCount: Number(summary.listingCount || 0),
      bookingCount: Number(summary.bookingCount || 0),
      isOwn: markOwn(email, vendor.id),
    });
  }

  for (const app of applications) {
    const email = normalizeEmail(app.email);
    const linked = vendors.find((vendor) => normalizeEmail(vendor.email) === email);
    if (linked) {
      const current = rows.get(linked.id);
      if (current && !current.projectName) current.projectName = app.projectName || current.projectName;
      continue;
    }
    const vendorId = summaries[app.id] ? app.id : app.id;
    const summary = summaries[vendorId] || summaries[app.id] || {};
    rows.set(vendorId, {
      vendorId,
      name: applicationName(app),
      projectName: app.projectName || '',
      email,
      status: app.status,
      listingCount: Number(summary.listingCount || 0),
      bookingCount: Number(summary.bookingCount || 0),
      isOwn: markOwn(email, vendorId),
    });
  }

  if (summaries[input.actor.id] && !rows.has(input.actor.id)) {
    rows.set(input.actor.id, {
      vendorId: input.actor.id,
      name: 'حسابك كمورّد',
      projectName: '',
      email: actorEmail,
      status: 'approved',
      listingCount: Number(summaries[input.actor.id].listingCount || 0),
      bookingCount: Number(summaries[input.actor.id].bookingCount || 0),
      isOwn: true,
    });
  }

  return Array.from(rows.values()).sort((a, b) => {
    if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
    const rank = { approved: 0, pending: 1, rejected: 2 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return a.name.localeCompare(b.name, 'ar');
  });
}
