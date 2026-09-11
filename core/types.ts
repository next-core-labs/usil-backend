export type ServiceCategory =
  | 'all'
  | 'hospitality'
  | 'buffet'
  | 'decoration'
  | 'photography'
  | 'entertainment'
  | 'halls'
  | 'rental'
  | 'servers'
  | 'av'
  | 'tents'
  | 'zaffa'
  | 'cakes'
  | 'invitations'
  | 'parking'
  | 'condolence';

/** Honest city fulfillment windows — not courier GPS or 15-minute promises. */
export type FulfillmentLane = 'hour' | 'same_day' | 'tomorrow' | 'instant';

/**
 * طريقة تأكيد الحجز — غير مسار «حجز فوري» في FulfillmentLane.
 * instant: الحجز يتأكد مباشرة. approval: ينتظر موافقة المورّد.
 */
export type BookingConfirmationMode = 'instant' | 'approval';

export interface ServiceItem {
  id: string;
  title: string;
  category: ServiceCategory;
  categoryName: string;
  shortDesc: string;
  fullDesc: string;
  price: number;
  priceUnit: 'للمناسبة' | 'للساعة' | 'للشخص' | 'لليوم' | 'للوحدة';
  originalPrice?: number;
  minNotice: string;
  minQuantity?: number;
  cities: string[];
  image: string;
  galleryImages?: string[];
  rating: number;
  reviewsCount: number;
  badge?: 'حجز فوري' | 'الأكثر طلباً' | 'مميز' | 'خصم حصري';
  /** طريقة تأكيد الحجز التي اختارها المورّد للمنتج. */
  bookingMode?: BookingConfirmationMode;
  features: string[];
  includes: string[];
  provider: {
    id?: string;
    name: string;
    verified: boolean;
    rating: number;
    completedOrders: number;
    responseTime: string; // e.g. "خلال 8 دقائق ⚡"
    responseRate: string; // e.g. "99%"
    aiResponseBadge?: string; // e.g. "استجابة فائقة السرعة معتمدة بالذكاء الاصطناعي"
    phone?: string;
    avatar?: string;
    socials?: Array<{
      network: 'instagram' | 'tiktok' | 'snapchat' | 'x' | 'youtube' | 'whatsapp';
      handle: string;
      url: string;
      status: 'pending' | 'linked' | 'verified';
    }>;
  };
  /** Saudi marketplace fields */
  audience?: 'women' | 'men' | 'family' | 'corporate';
  occasions?: string[];
  tags?: string[];
  aliases?: string[];
  vatIncluded?: boolean;
  cancellationHours?: number;
  delayGuarantee?: boolean;
  licensedKitchen?: boolean;
  /** Lanes this SKU can actually start/deliver in. Multiple vendors share a lane. */
  fulfillment?: FulfillmentLane[];
}

export interface BookingItem {
  service: ServiceItem;
  quantity: number;
  date: string;
  time: string;
  city: string;
  customNotes?: string;
  guestCount?: number;
}

export interface EventQuoteRequest {
  eventType: string;
  guestCount: number;
  city: string;
  date: string;
  selectedServices: string[];
  fullName: string;
  phone: string;
  notes: string;
}

// === VENDOR OPERATING SYSTEM TYPES ===

export type BookingSource = 'platform' | 'external_phone' | 'external_instagram' | 'external_whatsapp' | 'direct_bio_link';
export type BookingStatus = 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'pending_deposit';

export interface VendorBooking {
  id: string;
  bookingNumber: string;
  serviceId: string;
  serviceTitle: string;
  customerName: string;
  customerPhone: string;
  customerRating?: number; // e.g. 4.95
  customerReviewsCount?: number;
  customerBadge?: string; // e.g. "عميل ذهبي مميز"
  date: string; // YYYY-MM-DD
  startTime: string;
  endTime: string;
  city: string;
  venueName: string;
  guestCount: number;
  totalAmount: number;
  depositAmount: number;
  remainingAmount: number;
  source: BookingSource;
  status: BookingStatus;
  notes?: string;
  assignedCrew?: string[];
  hasConflict?: boolean;
  venueCoordinates?: {
    lat: number;
    lng: number;
    addressText?: string;
    geofenceRadiusMeters?: number;
  };
  createdAt: string;
}

export interface BlockedDate {
  id: string;
  date: string;
  reason: string;
  type: 'full_day' | 'maintenance' | 'holiday' | 'custom';
}

export interface WhatsAppMessage {
  id: string;
  sender: 'client' | 'vendor' | 'system';
  senderName?: string;
  text: string;
  timestamp: string;
  status?: 'sent' | 'delivered' | 'read';
  attachmentType?: 'quote_card' | 'invoice_pdf' | 'location_pin' | 'image';
  attachmentData?: any;
}

export interface WhatsAppThread {
  id: string;
  clientName: string;
  clientPhone: string;
  clientRating?: number;
  clientBadge?: string;
  clientAvatar?: string;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  relatedServiceId?: string;
  eventDate?: string;
  messages: WhatsAppMessage[];
  statusTag?: 'استفسار جديد' | 'تم إرسال العرض' | 'حجز مؤكد' | 'مكتمل';
}

export interface CrewWorkHourLog {
  id: string;
  crewId: string;
  crewName?: string;
  bookingId?: string;
  eventTitle: string;
  eventDate: string;
  regularHours: number; // عدد ساعات العمل الأساسية
  overtimeHours: number; // الساعات الإضافية
  hourlyRate: number; // أجر الساعة (ر.س)
  overtimeRate?: number; // أجر الساعة الإضافية
  totalEarned: number; // الإجمالي المستحق
  status: 'unprocessed' | 'processed_in_payroll';
  notes?: string;
  recordedAt?: string;
}

export interface CrewAttendanceRecord {
  id: string;
  crewId: string;
  crewName: string;
  bookingId: string;
  bookingNumber: string;
  eventTitle: string;
  venueName: string;
  checkInTime: string;
  checkInCoordinates: { lat: number; lng: number; accuracy?: number };
  checkOutTime?: string;
  checkOutCoordinates?: { lat: number; lng: number; accuracy?: number };
  geofenceStatus: 'verified_inside' | 'manual_override' | 'proximity_warning';
  distanceToVenueMeters: number;
  durationMinutes?: number;
  autoTriggered: boolean;
  notes?: string;
}

export interface CrewMember {
  id: string;
  name: string;
  role: 'مشرف ضيافة' | 'مباشر قهوة' | 'شيف بوفيه' | 'فني صوت وإضاءة' | 'سائق توصيل' | 'مصور';
  phone: string;
  avatar: string;
  status: 'available' | 'on_mission' | 'off_duty';
  assignedBookingsCount: number;
  hourlyRate?: number; // معدل الأجر بالساعة (ر.س/ساعة)
  overtimeMultiplier?: number; // مضاعف الوقت الإضافي (مثلاً 1.5)
  bankIban?: string; // الآيبان البنكي
  bankName?: string; // اسم البنك
  totalLoggedHours?: number; // إجمالي الساعات المسجلة
  workLogs?: CrewWorkHourLog[]; // سجل المناوبات وساعات العمل
  currentLocation?: {
    lat: number;
    lng: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
    lastUpdated?: string;
    addressName?: string;
  };
  activeCheckIn?: {
    bookingId: string;
    bookingNumber: string;
    eventTitle: string;
    venueName: string;
    checkInTime: string;
    checkInLat: number;
    checkInLng: number;
    verifiedGeofence: boolean;
    distanceMeters: number;
  } | null;
  attendanceHistory?: CrewAttendanceRecord[];
}

export interface VendorBrandSettings {
  brandName: string;
  slogan: string;
  logoUrl: string;
  stampUrl?: string;
  crNumber: string; // السجل التجاري أو وثيقة العمل الحر
  vatNumber: string; // الرقم الضريبي
  phone: string;
  email: string;
  city: string;
  address: string;
  primaryColor: string; // Hex color for branded templates
  bankName: string;
  accountHolder: string;
  iban: string;
  invoiceHeaderNote: string;
  invoiceFooterNotes: string;
  showWatermark: boolean;
  responseTime?: string;
  aiTrustBadge?: string;
  /** Vendor opt-in: «أقدر أخدم في» these fulfillment lanes. */
  fulfillment?: FulfillmentLane[];
}

export type MultiChannelSource = 
  | 'mithyaf' // يوصل marketplace (15% commission) — internal source id, do not rename
  | 'external_phone' // اتصال هاتفي مباشر (0% commission)
  | 'external_instagram' // إنستقرام (0% commission)
  | 'external_whatsapp' // واتساب مباشر (0% commission)
  | 'external_haraj' // موقع حراج (0% commission)
  | 'external_maroof' // معروف / سلة (0% commission)
  | 'direct_bio_link' // رابط البايو الخاص (0% commission)
  | 'pos_cashier'; // كاشير المحل / المعرض (0% commission)

export interface EventTrackingStep {
  id: string;
  title: string;
  description: string;
  timestamp?: string;
  isCompleted: boolean;
  isCurrent: boolean;
  badgeText?: string;
}

export interface ClientOrderTracking {
  id: string;
  trackingCode: string;
  bookingNumber: string;
  clientName: string;
  clientPhone: string;
  clientRating?: number;
  clientBadge?: string;
  serviceTitle: string;
  vendorName?: string;
  vendorRating?: number;
  vendorResponseTime?: string;
  eventDate: string;
  eventTime: string;
  venueName: string;
  city: string;
  guestCount: number;
  totalAmount: number;
  depositPaid: number;
  remainingBalance: number;
  status: 'draft' | 'confirmed' | 'preparing' | 'on_the_way' | 'setup_ready' | 'completed';
  assignedSupervisor?: {
    name: string;
    phone: string;
    avatar: string;
    role: string;
  };
  timeline: EventTrackingStep[];
  liveLocationCoordinates?: {
    lat: number;
    lng: number;
    addressText: string;
  };
  setupPhotos?: string[];
  notesToClient?: string;
  source: MultiChannelSource;
  isWhiteLabel: boolean;
  reviewStatus?: 'pending_client' | 'pending_vendor' | 'revealed' | 'not_started';
  doubleBlindReviewId?: string;
}

export interface POSItem {
  id: string;
  title: string;
  sku?: string;
  barcode?: string;
  category: 'ضيافة' | 'معدات' | 'طواقم' | 'بوفيهات' | 'حلويات وعصائر' | 'إضافات';
  price: number;
  unit: string;
  icon?: string;
  inStock?: boolean;
  isQuickAddOn?: boolean;
  description?: string;
}

export interface POSCartItem {
  item: POSItem;
  quantity: number;
  customPrice?: number;
  notes?: string;
}

export interface NFCPaymentData {
  cardScheme: 'mada' | 'apple_pay' | 'visa' | 'mastercard';
  maskedPan: string;
  authCode: string;
  rrn: string;
  terminalId: string;
  aid: string;
  cardHolderName?: string;
  nfcTech: string;
  timestamp: string;
  contactlessVerified: boolean;
}

export interface POSSaleRecord {
  id: string;
  receiptNumber: string;
  customerName: string;
  customerPhone: string;
  customerRating?: number;
  customerBadge?: string;
  eventDate: string;
  items: POSCartItem[];
  subtotal: number;
  taxAmount: number;
  discount: number;
  total: number;
  paidAmount: number;
  paymentMethod: 'mada' | 'visa' | 'apple_pay' | 'cash' | 'bank_transfer' | 'tap_to_pay_nfc';
  nfcPaymentData?: NFCPaymentData;
  source: 'pos_cashier';
  createdAt: string;
  status: 'completed' | 'refunded';
}

export interface VendorInvoice {
  id: string;
  invoiceNumber: string;
  bookingId?: string;
  trackingCode?: string;
  clientName: string;
  clientPhone: string;
  clientRating?: number;
  clientBadge?: string;
  clientTaxId?: string;
  eventDate: string;
  issueDate: string;
  dueDate: string;
  items: {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  subtotal: number;
  taxRate: number; // 0.15 for 15% VAT
  taxAmount: number;
  discount: number;
  total: number;
  depositPaid: number;
  remainingBalance: number;
  status: 'paid' | 'partial' | 'draft' | 'unpaid';
  terms: string;
  paymentMethod: 'مدى / فيزا' | 'تحويل بنكي' | 'نقداً عند الوصول' | 'حساب الضمان' | 'Apple Pay';
  isWhiteLabel?: boolean;
  channelSource?: MultiChannelSource;
  platformFeeRate?: number; // 0 for external/POS, 0.15 for mithyaf
  platformFeeAmount?: number;
  vendorNetAmount?: number;
}

export interface FinancialPayout {
  id: string;
  reference: string;
  amount: number;
  date: string;
  status: 'completed' | 'processing' | 'held_escrow';
  description: string;
  bankAccount: string;
  feeDeducted?: number;
  netAmount?: number;
  requestedAt?: string;
  bankName?: string;
  ibanMasked?: string;
}

// === TWO-SIDED BLIND REVIEWS & AI REPUTATION SUITE ===

export type BlindReviewStatus = 'waiting_both' | 'waiting_vendor' | 'waiting_client' | 'revealed';

export interface ClientReviewSubmission {
  overallRating: number; // 1 - 5
  punctualityRating: number; // 1 - 5 (الالتزام بالموعد)
  qualityRating: number; // 1 - 5 (جودة الخدمة والمذاق)
  crewRating: number; // 1 - 5 (لباقة واحترافية الطاقم)
  comment: string;
  tags: string[];
  submittedAt: string;
}

export interface VendorReviewSubmission {
  overallRating: number; // 1 - 5
  clarityRating: number; // 1 - 5 (وضوح المتطلبات)
  punctualityRating: number; // 1 - 5 (جاهزية الموقع والاستقبال في الموعد)
  paymentRating: number; // 1 - 5 (الالتزام بالسداد وسلاسة التعامل)
  comment: string;
  tags: string[];
  submittedAt: string;
}

export interface DoubleBlindReview {
  id: string;
  bookingId: string;
  bookingNumber: string;
  serviceTitle: string;
  eventDate: string;
  
  // Vendor Info
  vendorId?: string;
  vendorName: string;
  vendorAvatar?: string;
  vendorResponseTime: string;
  vendorRating: number;
  
  // Client Info
  clientId?: string;
  clientName: string;
  clientPhone: string;
  clientAvatar?: string;
  clientRating: number; // Historical overall customer rating
  clientBadge?: string;
  
  // Blind Status
  status: BlindReviewStatus;
  
  // Reviews (Secret until both submitted)
  clientReview?: ClientReviewSubmission;
  vendorReview?: VendorReviewSubmission;
  
  // AI-generated consensus & highlights
  aiSummary?: string;
  aiTrustMatch?: number; // e.g. 99%
  revealedAt?: string;
}

export interface AIEvaluationSummary {
  summary: string;
  strengths: string[];
  aiTrustScore: number;
  aiGenerated: boolean;
}

// === COMPREHENSIVE FINANCIAL & ACCOUNTING SUITE TYPES ===

export type ExpenseCategory =
  | 'raw_materials' // خامات ومواد تموينية (بن، تمور، فواكه، لحوم)
  | 'inventory_supplies' // توريدات ومستلزمات المخزون والمستهلكات
  | 'direct_labor' // عمالة مؤقتة ومباشرين باليومية
  | 'crew_wages' // مسير أجور الطاقم وسندات الصرف الموحدة
  | 'fuel_transport' // وقود، نقل، مشاوير
  | 'maintenance_tools' // صيانة عتاد، أدوات ضيافة، غسيل ومغاسل
  | 'packaging_disposables' // علب، أكياس، فناجيل وملاعق استهلاكية
  | 'marketing_ads' // إعلانات وتسويق
  | 'utilities_rent' // إيجار مستودع/معرض، كهرباء، إنترنت
  | 'other_petty_cash'; // نثريات وضيافة داخلية

export interface ExpenseRecord {
  id: string;
  voucherNumber: string; // سند صرف
  title: string;
  category: ExpenseCategory;
  amount: number; // المبلغ قبل الضريبة أو الإجمالي
  taxRate: number; // 0.15 أو 0
  taxAmount: number; // ضريبة المدخلات
  totalAmount: number;
  paymentMethod: 'cash' | 'mada' | 'bank_transfer' | 'petty_cash';
  paidTo: string; // المورّد أو الجهة المستفيدة
  invoiceReference?: string; // رقم فاتورة المورد الضريبية
  date: string;
  notes?: string;
  relatedBookingId?: string; // ربط المصروف بمناسبة معينة لاحتساب تكلفتها
  receiptImageUrl?: string;
}

export interface ReceivableDebt {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  serviceTitle: string;
  eventDate: string;
  totalAmount: number;
  depositPaid: number;
  remainingAmount: number;
  dueDate: string;
  agingDays: number; // كم يوم مضى على استحقاق الدين
  status: 'current' | 'due_soon' | 'overdue_1_15' | 'overdue_16_30' | 'overdue_30_plus' | 'collected';
  lastReminderSentDate?: string;
  remindersCount: number;
}

export interface EventUnitCosting {
  bookingId: string;
  bookingNumber: string;
  clientName: string;
  serviceTitle: string;
  eventDate: string;
  revenue: number; // سعر البيع للعميل
  rawMaterialsCost: number; // تكلفة الخامات
  directLaborCost: number; // تكلفة المباشرين والعمالة
  transportCost: number; // تكلفة التوصيل والوقود
  consumablesCost: number; // تكلفة المستهلكات
  platformFeeCost: number; // عمولة المنصة إن وجدت
  totalDirectCost: number; // إجمالي التكاليف المباشرة
  grossProfit: number; // صافي ربح المناسبة
  profitMarginPercent: number; // نسبة هامش الربح %
  status: 'high_profit' | 'normal_profit' | 'low_margin' | 'loss';
}

export interface CrewPayrollEntry {
  id: string;
  crewId: string;
  crewName: string;
  role: string;
  bookingId?: string;
  eventTitle: string;
  eventDate: string;
  regularHours?: number; // عدد ساعات العمل
  overtimeHours?: number; // ساعات العمل الإضافي
  hourlyRate?: number; // أجر الساعة الأساسي
  earnedAmount: number;
  bonusAmount?: number;
  deductionAmount?: number;
  netPayout: number;
  paymentStatus: 'pending' | 'paid';
  paidAt?: string;
  paymentMethod?: 'bank_transfer' | 'cash';
  consolidatedVoucherNumber?: string; // رقم سند الصرف الموحد المرتبط
  bankIban?: string;
}

export interface ConsolidatedCrewPaymentVoucher {
  id: string;
  voucherNumber: string; // e.g. "CPV-2026-0042"
  issueDate: string;
  paidDate?: string;
  title: string; // عنوان سند الصرف الموحد
  payrollEntryIds: string[];
  entriesSummary: Array<{
    entryId: string;
    crewId: string;
    crewName: string;
    role: string;
    eventTitle: string;
    eventDate: string;
    regularHours: number;
    overtimeHours: number;
    hourlyRate: number;
    grossAmount: number;
    bonusAmount: number;
    deductionAmount: number;
    netPayout: number;
    bankIban?: string;
    bankName?: string;
  }>;
  totalCrewCount: number;
  totalRegularHours: number;
  totalOvertimeHours: number;
  totalHours: number;
  totalGrossAmount: number;
  totalBonusAmount: number;
  totalDeductionAmount: number;
  totalConsolidatedAmount: number;
  paymentMethod: 'bank_transfer' | 'cash' | 'mada';
  bankReferenceNumber?: string;
  status: 'issued_pending' | 'paid_completed';
  recordedAsExpenseId?: string; // ربط بسند الصرف في سجل المصروفات
  preparedBy: string;
  approvedBy: string;
  notes?: string;
}

export interface VatQuarterlyReport {
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  year: number;
  quarterLabel: string;
  startDate: string;
  endDate: string;
  taxableSalesStandardRate: number; // المبيعات الخاضعة للنسبة الأساسية 15%
  salesOutputTax: number; // ضريبة المخرجات المحصلة من العملاء
  taxablePurchasesStandardRate: number; // المشتريات والمصروفات الخاضعة للنسبة 15%
  purchasesInputTax: number; // ضريبة المدخلات القابلة للخصم
  netVatPayable: number; // صافي الضريبة المستحقة للهيئة (ضريبة المخرجات - ضريبة المدخلات)
  totalInvoicesCount: number;
  totalExpensesCount: number;
}

// === AUTHENTICATION & USER PROFILE TYPES ===

export interface UserProfile {
  id: string;
  name: string;
  phone: string;
  email: string;
  role: 'client' | 'vendor' | 'admin' | 'accounts_manager' | 'courier';
  verified: boolean;
  emailVerified?: boolean;
  avatar?: string;
  avatarUrl?: string;
  loyaltyTier: string;
  walletBalance: number;
  rating: number;
  savedAddresses?: Array<{
    id: string;
    title: string;
    city: string;
    district: string;
    isDefault: boolean;
  }>;
}

// === VOICE AI CONCIERGE TYPES ===

export interface VoiceAssistantMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  spokenAudio?: string;
  timestamp: string;
  action?: 'recommend_service' | 'add_to_cart' | 'calculate_budget' | 'filter_category' | 'faq';
  suggestedServiceIds?: string[];
  estimatedBudget?: number;
  bundleDiscount?: number;
  quickOptions?: string[];
}

export interface SmartBundleProposal {
  id: string;
  title: string;
  badge: string;
  description: string;
  services: ServiceItem[];
  originalTotal: number;
  discountedTotal: number;
  savings: number;
  discountPercent: number;
  guestCapacity: number;
  popularFor: string;
}

// === SMART CONTRACTS & B2B INTERACTIVE QUOTATIONS ===

export interface SmartServiceContract {
  id: string;
  contractNumber: string;
  bookingId: string;
  clientName: string;
  clientNationalId?: string;
  clientPhone: string;
  vendorName: string;
  vendorCrNumber: string;
  eventDate: string;
  eventLocation: string;
  serviceTitle: string;
  totalAmount: number;
  depositAmount: number;
  remainingAmount: number;
  status: 'draft' | 'pending_signature' | 'signed_active' | 'completed';
  terms: string[];
  clientSignature?: {
    signatureImage?: string;
    signedByName: string;
    signedAt: string;
    ipAddress?: string;
  };
  vendorSignature?: {
    signedByName: string;
    signedAt: string;
    stampApplied: boolean;
  };
  createdAt: string;
}

export interface InteractiveQuotationProposal {
  id: string;
  quoteNumber: string;
  clientName: string;
  clientPhone: string;
  companyName?: string;
  eventTitle: string;
  eventDate: string;
  guestCount: number;
  city: string;
  items: Array<{
    title: string;
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  grandTotal: number;
  depositRequired: number;
  validUntil: string;
  status: 'sent' | 'viewed' | 'accepted' | 'rejected' | 'converted_to_booking';
  customNote?: string;
  createdAt: string;
}

// === QUALITY CONTROL & EVENT READINESS CHECKLIST ===

export interface ReadinessChecklistItem {
  id: string;
  category: 'equipment' | 'ingredients' | 'staff_uniform' | 'logistics';
  title: string;
  subtitle?: string;
  checked: boolean;
  assignedTo?: string;
  checkedAt?: string;
}

export interface EventReadinessAudit {
  id: string;
  bookingNumber: string;
  eventTitle: string;
  eventDate: string;
  supervisorName: string;
  items: ReadinessChecklistItem[];
  overallProgress: number; // percentage 0 - 100
  isApprovedForDispatch: boolean;
  notes?: string;
}

// === VIP LOYALTY & HOSPITALITY GIFT CARDS ===

export interface HospitalityGiftCard {
  id: string;
  code: string;
  recipientName: string;
  recipientPhone: string;
  senderName: string;
  message: string;
  amount: number;
  balance: number;
  expiryDate: string;
  status: 'active' | 'redeemed' | 'expired';
  theme: 'gold_luxury' | 'saudi_coffee' | 'royal_wedding' | 'corporate_celebration';
  createdAt: string;
}

// === INVENTORY MANAGEMENT & DEMAND FORECASTING ===

export type InventoryCategory =
  | 'disposables' // أكواب، صحون، فناجيل، مناديل
  | 'raw_beverages' // بن قهوة سعودية، بن إسبريسو، هيل، زعفران، شاي
  | 'ingredients' // حليب، نكهات، سكر، تمور، شوكولاتة
  | 'equipment_assets' // دلال، مكائن، مباخر، كاسات زجاجية
  | 'presentation_ware' // صواني تقديم، استاندات، مفارش
  | 'uniforms_cleaners'; // أزياء الضيافة ومواد التعقيم

export interface InventoryItem {
  id: string;
  nameAr: string;
  nameEn?: string;
  category: InventoryCategory;
  currentStock: number;
  minStockThreshold: number;
  unit: string; // e.g. "كرتون", "كوب", "كجم", "حبة", "لتر"
  unitCost: number; // سعر شراء الوحدة بالريال
  estimatedUsagePerGuest: number; // معدل الاستهلاك التقريبي لكل ضيف في المناسبة
  leadTimeDays?: number; // أيام التوريد المتوقعة
  supplierName?: string;
  supplierPhone?: string;
  barcode?: string;
  location?: string; // موقع التخزين في المستودع
  lastRestockedAt?: string;
  createdAt?: string;
  notes?: string;
}

export interface InventoryDemandForecast {
  item: InventoryItem;
  forecastedUsageCount: number; // إجمالي الاستهلاك المتوقع بناءً على الضيوف والحجوزات القادمة
  upcomingEventsCount: number; // عدد المناسبات المجدولة
  upcomingGuestsCount: number; // إجمالي عدد الضيوف في المناسبات المجدولة
  remainingProjectedStock: number; // الرصيد المتبقي المتوقع بعد المناسبات
  shortageAmount: number; // كمية العجز إن وجد
  status: 'safe' | 'low_stock' | 'critical_shortage';
  urgencyDays: number;
  suggestedReorderQuantity: number;
  estimatedReorderCost: number;
}


