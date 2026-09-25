import fs from 'fs';
import path from 'path';

/** Test fixtures shared by the catalog, SEO and AI suites. Not a test file itself. */

export function listingFixture(vendorId: string, id: string, title: string) {
  const now = new Date().toISOString();
  return {
    id,
    vendorId,
    vendorName: `مورد ${vendorId}`,
    title,
    category: 'hospitality',
    categoryName: 'ضيافة وقهوة',
    shortDesc: `وصف ${title}`,
    price: 250,
    priceUnit: 'للمناسبة',
    cities: ['الرياض'],
    images: [`/uploads/listing-${id}.jpg`],
    fulfillment: ['hour'],
    bookingMode: 'approval',
    createdAt: now,
    updatedAt: now,
  };
}

/** One approved vendor and one rejected (no longer a vendor account), each with a sellable listing. */
export function seedApprovedAndRejected(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify([
      { id: 'usr-approved', email: 'ok@vendor.sa', name: 'مورد معتمد', role: 'vendor' },
      { id: 'usr-rejected', email: 'no@vendor.sa', name: 'مورد مرفوض', role: 'client' },
    ]),
  );
  fs.writeFileSync(
    path.join(dir, 'vendor-workspaces.json'),
    JSON.stringify({
      workspaces: {
        'usr-approved': { listings: [listingFixture('usr-approved', 'lst-approved', 'قهوة المورد المعتمد')] },
        'usr-rejected': { listings: [listingFixture('usr-rejected', 'lst-rejected', 'قهوة المورد المرفوض')] },
      },
    }),
  );
}
