import { publicSocials, type VendorSocials } from './vendor-socials';

export type VendorApplicationStatus = 'pending' | 'approved' | 'rejected';

export type VendorProfileSource = {
  id?: string;
  firstName?: string;
  fatherName?: string;
  familyName?: string;
  projectName?: string;
  projectType?: string;
  logoUrl?: string;
  email?: string;
  phone?: string;
  fulfillment?: string[];
  socials?: VendorSocials;
  status?: VendorApplicationStatus;
  commercialRegister?: string;
};

export type VendorWorkspaceProfile = {
  projectName: string;
  personName: string;
  projectType: string;
  logoUrl?: string;
  email: string;
  phone: string;
  fulfillment: string[];
  commercialRegister?: string;
};

export type VendorOwnProfile = VendorWorkspaceProfile & {
  vendorId: string;
  status: VendorApplicationStatus;
  socials?: VendorSocials;
  listingCount: number;
};

export type VendorPublicFile = {
  vendorId: string;
  projectName: string;
  personName: string;
  projectType: string;
  logoUrl?: string;
  fulfillment: string[];
  socials: ReturnType<typeof publicSocials>;
  listingCount: number;
  handle: string;
};

export function personNameFromParts(input: {
  firstName?: string;
  fatherName?: string;
  familyName?: string;
}): string {
  return `${input.firstName || ''} ${input.fatherName || ''} ${input.familyName || ''}`.replace(/\s+/g, ' ').trim();
}

export function vendorHandle(projectName: string, vendorId: string): string {
  const fromName = String(projectName || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (fromName) return fromName;
  const tail = String(vendorId || '').replace(/^usr-/, '').slice(-8);
  return tail || 'vendor';
}

export function profileFromApplication(
  source: VendorProfileSource,
  vendorId: string,
  extra?: { listingCount?: number },
): VendorOwnProfile {
  const projectName = String(source.projectName || '').trim();
  const personName = personNameFromParts(source);
  return {
    vendorId,
    status: source.status || 'pending',
    projectName,
    personName,
    projectType: String(source.projectType || '').trim(),
    logoUrl: source.logoUrl || undefined,
    email: String(source.email || '').trim().toLowerCase(),
    phone: String(source.phone || '').trim(),
    fulfillment: Array.isArray(source.fulfillment) ? source.fulfillment.map(String) : [],
    commercialRegister: source.commercialRegister || undefined,
    socials: source.socials,
    listingCount: Number(extra?.listingCount || 0),
  };
}

export function workspaceProfileFromOwn(profile: VendorOwnProfile): VendorWorkspaceProfile {
  return {
    projectName: profile.projectName,
    personName: profile.personName,
    projectType: profile.projectType,
    logoUrl: profile.logoUrl,
    email: profile.email,
    phone: profile.phone,
    fulfillment: profile.fulfillment,
    commercialRegister: profile.commercialRegister,
  };
}

export function publicVendorFile(
  profile: VendorOwnProfile,
): VendorPublicFile {
  return {
    vendorId: profile.vendorId,
    projectName: profile.projectName,
    personName: profile.personName,
    projectType: profile.projectType,
    logoUrl: profile.logoUrl,
    fulfillment: profile.fulfillment,
    socials: publicSocials(profile.socials),
    listingCount: profile.listingCount,
    handle: vendorHandle(profile.projectName, profile.vendorId),
  };
}
