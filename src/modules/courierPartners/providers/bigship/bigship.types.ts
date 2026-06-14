export type BigshipLoginRequest = {
  username: string;
  password: string;
  access_key: string;
};

export type BigshipLoginResponse = {
  token?: string;
  expires_in?: number;
  expiresIn?: number;
  success?: boolean;
  message?: string;
};

export type BigshipSaveWarehouseRequest = {
  warehouseName: string;
  contactPerson: string;
  phone: string;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  country: string;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type BigshipSaveWarehouseResponse = {
  warehouseId?: string;
  status?: string;
  message?: string;
};

export type BigshipDomesticB2COrderRequest = {
  MasterCustomOrderId: string;
  MasterOrderPickUpLocation: string;
  MasterOrderReturnLocation?: string | null;
  MasterOrderShippingName: string;
  MasterOrderShippingPhone: string;
  MasterOrderShippingEmail?: string | null;
  MasterOrderShippingAddressLine1: string;
  MasterOrderShippingAddressLine2?: string | null;
  MasterOrderShippingLandmark?: string | null;
  MasterOrderShippingCity: string;
  MasterOrderShippingState: string;
  MasterOrderShippingCountry: string;
  MasterOrderShippingPincode: string;
  MasterOrderInvoiceNumber?: string | null;
  MasterOrderInvoiceAmount: number;
  MasterOrderCollectableAmount: number;
  MasterOrderPaymentMode: "prepaid" | "cod";
  MasterOrderWeightKg: number;
  MasterOrderLengthCm: number;
  MasterOrderBreadthCm: number;
  MasterOrderHeightCm: number;
};

export type BigshipDomesticB2COrderResponse = {
  order_id?: string;
  orderId?: string;
  reference_number?: string;
  status?: string;
  message?: string;
};

export type BigshipCourierRateRequest = {
  order_id?: string | null;
  pickup_pincode: string;
  delivery_pincode: string;
  payment_mode: "prepaid" | "cod";
  collectable_amount: number;
  weight_kg: number;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
};

export type BigshipCourierRate = {
  courierId?: string;
  courier_id?: string;
  courierName?: string;
  courier_name?: string;
  total_charge?: number;
  totalCharge?: number;
  base_freight?: number;
  cod_charge?: number;
  tax?: number;
  charged_weight?: number;
  chargedWeight?: number;
  tat?: number;
  tat_days?: number;
  recommended?: boolean;
};

export type BigshipCourierRateResponse = {
  rates?: BigshipCourierRate[];
  data?: BigshipCourierRate[];
  status?: string;
  message?: string;
};

export type BigshipPlaceOrderRequest = {
  order_id: string;
  courierId: string;
};

export type BigshipPlaceOrderResponse = {
  awb_assigned?: string;
  awb?: string;
  tracking_number?: string;
  label_url?: string;
  labelUrl?: string;
  tracking_url?: string;
  trackingUrl?: string;
  reference_number?: string;
  status?: string;
  message?: string;
};

export type BigshipGetLabelRequest = {
  awb?: string | null;
  tracking_number?: string | null;
  order_id?: string | null;
  shipment_id?: string | null;
};

export type BigshipGetLabelResponse = {
  label_url?: string | null;
  labelUrl?: string | null;
  tracking_url?: string | null;
  trackingUrl?: string | null;
  status?: string;
  message?: string;
};

export type BigshipTrackingRequest = {
  awb?: string | null;
  tracking_number?: string | null;
  order_id?: string | null;
};

export type BigshipTrackingEvent = {
  status?: string;
  public_status?: string;
  location?: string | null;
  message?: string;
  remarks?: string;
  checkpoint_time?: string;
  timestamp?: string;
};

export type BigshipTrackingResponse = {
  awb?: string | null;
  tracking_number?: string | null;
  status?: string;
  latest_event?: string | null;
  events?: BigshipTrackingEvent[];
  timeline?: BigshipTrackingEvent[];
  message?: string;
};

export type BigshipCancelOrderRequest = {
  awb?: string | null;
  tracking_number?: string | null;
  order_id?: string | null;
  reason?: string | null;
};

export type BigshipCancelOrderResponse = {
  cancelled?: boolean;
  status?: string;
  message?: string;
};
