import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import "./styles.css";

const emptyCustomer = { name: "", phone: "", address: "", gstin: "", stateCode: "", whatsappOptIn: false, whatsappOptInAt: "" };
const emptyProduct = {
  id: "",
  name: "",
  barcode: "",
  sku: "",
  category: "",
  hsnCode: "",
  gstRate: "18",
  price: "",
  cost: "",
  stock: "",
  imageUrl: "",
  imageData: "",
  removeImage: false,
};
const emptyManualItem = {
  name: "",
  barcode: "",
  category: "",
  hsnCode: "",
  gstRate: "18",
  qty: "1",
  price: "",
  cost: "",
  discountMode: "percentage",
  discountValue: "25",
  saveToCatalog: false,
  stock: "1",
};

function formattedAmount(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number(value || 0) % 1 ? 2 : 0,
  });
}

function money(value) {
  return `₹${formattedAmount(value)}`;
}

function receiptMoney(value) {
  return `₹${formattedAmount(value)}`;
}

function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthStartKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return dateKey(new Date(date.getFullYear(), date.getMonth(), 1));
}

function monthEndKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return dateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

function quarterStartKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  return dateKey(new Date(date.getFullYear(), quarterStartMonth, 1));
}

function quarterEndKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  return dateKey(new Date(date.getFullYear(), quarterStartMonth + 3, 0));
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) =>
    row.map((value) => {
      const text = String(value ?? "");
      return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    }).join(",")
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function lineGross(item) {
  return Math.max(0, Number(item.qty || 0) * Number(item.price || 0));
}

function lineDiscount(item) {
  const gross = lineGross(item);
  if (item.discountMode === "percentage") {
    const percentage = Math.min(100, Math.max(0, Number(item.discountValue || 0)));
    return gross * (percentage / 100);
  }
  if (item.discountMode === "fixed") {
    return Math.min(gross, Math.max(0, Number(item.discountValue || 0)));
  }
  return Math.min(gross, Math.max(0, Number(item.discount || 0)));
}

function lineTotal(item) {
  return Math.max(0, lineGross(item) - lineDiscount(item));
}

function lineTaxable(item) {
  return lineTotal(item);
}

function invoiceLineValue(invoice, item) {
  const taxable = Number(item.taxable || 0);
  if (invoice.invoiceType === "gst") return Math.max(0, taxable + Number(item.gstAmount || 0));
  if (taxable > 0) return taxable;
  return Math.max(0, Number(item.qty || 0) * Number(item.price || 0) - Number(item.discount || 0));
}

function applyPrintPage(invoiceType) {
  let style = document.getElementById("print-page-size");
  if (!style) {
    style = document.createElement("style");
    style.id = "print-page-size";
    document.head.appendChild(style);
  }
  style.textContent = invoiceType === "gst" ? "@page { size: A4; margin: 10mm; }" : "@page { size: 58mm auto; margin: 0; }";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed.");
  }
  return response.json();
}

function App() {
  const [activeView, setActiveView] = useState("billing");
  const [state, setState] = useState(null);
  const [customer, setCustomer] = useState(emptyCustomer);
  const [customerLookup, setCustomerLookup] = useState("");
  const [cart, setCart] = useState([]);
  const [barcode, setBarcode] = useState("");
  const [search, setSearch] = useState("");
  const [invoiceType, setInvoiceType] = useState("regular");
  const [gstType, setGstType] = useState("intrastate");
  const [discountMode, setDiscountMode] = useState("fixed");
  const [discountValue, setDiscountValue] = useState(0);
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMode, setPaymentMode] = useState("Cash");
  const [productForm, setProductForm] = useState(emptyProduct);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogStockFilter, setCatalogStockFilter] = useState("all");
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomer, setNewCustomer] = useState(emptyCustomer);
  const [customerForm, setCustomerForm] = useState(null);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [whatsappInboxSearch, setWhatsappInboxSearch] = useState("");
  const [returnSearch, setReturnSearch] = useState("");
  const [selectedReturnInvoiceId, setSelectedReturnInvoiceId] = useState("");
  const [returnType, setReturnType] = useState("return");
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState("");
  const [settlementMode, setSettlementMode] = useState("Cash");
  const [replacementSearch, setReplacementSearch] = useState("");
  const [replacementItems, setReplacementItems] = useState([]);
  const [exchangeManualItem, setExchangeManualItem] = useState(emptyManualItem);
  const [lastInvoice, setLastInvoice] = useState(null);
  const [lastReturn, setLastReturn] = useState(null);
  const [editingInvoiceId, setEditingInvoiceId] = useState("");
  const [salesPrint, setSalesPrint] = useState(null);
  const [salesPrintDate, setSalesPrintDate] = useState(dateKey());
  const [salesReportStart, setSalesReportStart] = useState(monthStartKey());
  const [salesReportEnd, setSalesReportEnd] = useState(dateKey());
  const [isBilling, setIsBilling] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState({ configured: false });
  const [whatsappCampaignMessage, setWhatsappCampaignMessage] = useState("");
  const [whatsappCampaignImage, setWhatsappCampaignImage] = useState({ name: "", data: "" });
  const [whatsappCampaignResult, setWhatsappCampaignResult] = useState(null);
  const [isSendingCampaign, setIsSendingCampaign] = useState(false);
  const [bulkWhatsAppOptInChecked, setBulkWhatsAppOptInChecked] = useState(false);
  const [isBulkOptingIn, setIsBulkOptingIn] = useState(false);
  const [sendingWhatsAppInvoiceId, setSendingWhatsAppInvoiceId] = useState("");
  const [notice, setNotice] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [manualItemOpen, setManualItemOpen] = useState(false);
  const [manualItem, setManualItem] = useState(emptyManualItem);
  const barcodeRef = useRef(null);
  const cameraVideoRef = useRef(null);

  useEffect(() => {
    loadState();
    loadWhatsAppStatus();
  }, []);

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let stream;
    let cancelled = false;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access is not supported in this browser");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          await cameraVideoRef.current.play();
          setCameraReady(true);
        }
      } catch (error) {
        setCameraOpen(false);
        showNotice(error.name === "NotAllowedError" ? "Camera permission was not granted" : error.message);
      }
    }

    startCamera();
    return () => {
      cancelled = true;
      setCameraReady(false);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraOpen]);

  async function loadState() {
    const data = await api("/api/state");
    setState(data);
  }

  async function loadWhatsAppStatus() {
    try {
      const data = await api("/api/whatsapp/status");
      setWhatsappStatus(data);
    } catch {
      setWhatsappStatus({ configured: false });
    }
  }

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  const totals = useMemo(() => {
    const gross = cart.reduce((sum, item) => sum + Number(item.qty || 0) * Number(item.price || 0), 0);
    const itemDiscount = cart.reduce((sum, item) => sum + lineDiscount(item), 0);
    const discountBase = Math.max(0, gross - itemDiscount);
    const billDiscount =
      discountMode === "percentage"
        ? discountBase * (Math.min(100, Math.max(0, Number(discountValue || 0))) / 100)
        : Math.min(discountBase, Math.max(0, Number(discountValue || 0)));
    const discount = itemDiscount + billDiscount;
    const taxable = Math.max(0, gross - discount);
    const cartTaxable = cart.reduce((sum, item) => sum + lineTaxable(item), 0);
    const billDiscountRatio = cartTaxable > 0 ? billDiscount / cartTaxable : 0;
    const tax =
      invoiceType === "gst"
        ? cart.reduce((sum, item) => sum + Math.max(0, lineTaxable(item) * (1 - billDiscountRatio)) * (Number(item.gstRate || 0) / 100), 0)
        : 0;
    const total = taxable + tax;
    const paid = Number(amountPaid || 0);
    return {
      gross,
      itemDiscount,
      billDiscount,
      discount,
      discountMode,
      discountValue: Number(discountValue || 0),
      taxable,
      tax,
      total,
      paid,
      balance: Math.max(0, total - paid),
    };
  }, [cart, invoiceType, discountMode, discountValue, amountPaid]);

  const todaySummary = useMemo(() => {
    if (!state) return { count: 0, total: 0 };
    const today = dateKey();
    const invoices = state.invoices.filter((invoice) => dateKey(invoice.date) === today);
    return { count: invoices.length, total: invoices.reduce((sum, invoice) => sum + Number(invoice.totals.total || 0), 0) };
  }, [state]);

  const filteredProducts = useMemo(() => {
    if (!state) return [];
    const query = search.trim().toLowerCase();
    if (!query) return state.products.slice(0, 8);
    return state.products.filter((product) =>
      [product.name, product.barcode, product.sku, product.category].join(" ").toLowerCase().includes(query)
    );
  }, [state, search]);

  const catalogProducts = useMemo(() => {
    if (!state) return [];
    const query = catalogSearch.trim().toLowerCase();
    return state.products
      .filter((product) => {
        const matchesSearch =
          !query ||
          [product.name, product.barcode, product.sku, product.category, product.hsnCode]
            .join(" ")
            .toLowerCase()
            .includes(query);
        const matchesStock =
          catalogStockFilter === "all" ||
          (catalogStockFilter === "in-stock" && Number(product.stock) > 0) ||
          (catalogStockFilter === "out-of-stock" && Number(product.stock) <= 0);
        return matchesSearch && matchesStock;
      })
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [state, catalogSearch, catalogStockFilter]);

  const filteredCustomers = useMemo(() => {
    if (!state) return [];
    const query = customerSearch.trim().toLowerCase();
    return state.customers.filter((item) => [item.name, item.phone, item.address].join(" ").toLowerCase().includes(query));
  }, [state, customerSearch]);

  const billingCustomerMatches = useMemo(() => {
    if (!state || !customerLookup.trim()) return [];
    const query = customerLookup.trim().toLowerCase();
    return state.customers
      .filter((item) => [item.name, item.phone, item.address].join(" ").toLowerCase().includes(query))
      .slice(0, 6);
  }, [state, customerLookup]);

  const phoneCustomerMatches = useMemo(() => {
    if (!state || !customer.phone.trim()) return [];
    const digits = customer.phone.replace(/\D/g, "");
    if (digits.length < 3) return [];
    return state.customers
      .filter((item) => item.phone?.replace(/\D/g, "").includes(digits))
      .slice(0, 5);
  }, [state, customer.phone]);

  const whatsappOptedInCustomers = useMemo(
    () => (state?.customers || []).filter((item) => item.whatsappOptIn && item.phone),
    [state]
  );

  const filteredInvoices = useMemo(() => {
    if (!state) return [];
    const query = invoiceSearch.trim().toLowerCase();
    return state.invoices
      .slice()
      .reverse()
      .filter((item) => [item.id, item.customer.name, item.customer.phone].join(" ").toLowerCase().includes(query));
  }, [state, invoiceSearch]);

  const filteredWhatsappMessages = useMemo(() => {
    if (!state) return [];
    const query = whatsappInboxSearch.trim().toLowerCase();
    return (state.whatsappMessages || [])
      .slice()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .filter((message) =>
        [message.customerName, message.from, message.to, message.text, message.status]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
  }, [state, whatsappInboxSearch]);

  const daySalesInvoices = useMemo(() => {
    if (!state) return [];
    return state.invoices
      .filter((invoice) => dateKey(invoice.date) === salesPrintDate)
      .sort((first, second) => new Date(first.date) - new Date(second.date));
  }, [state, salesPrintDate]);

  const daySalesSummary = useMemo(() => {
    return daySalesInvoices.reduce(
      (summary, invoice) => {
        summary.count += 1;
        summary.gross += Number(invoice.totals?.gross || 0);
        summary.discount += Number(invoice.totals?.discount || 0);
        summary.tax += Number(invoice.totals?.tax || 0);
        summary.total += Number(invoice.totals?.total || 0);
        summary.cash += invoice.paymentMode === "Cash" ? Number(invoice.totals?.total || 0) : 0;
        summary.upi += invoice.paymentMode === "UPI" ? Number(invoice.totals?.total || 0) : 0;
        summary.card += invoice.paymentMode === "Card" ? Number(invoice.totals?.total || 0) : 0;
        summary.mixed += invoice.paymentMode === "Mixed" ? Number(invoice.totals?.total || 0) : 0;
        return summary;
      },
      { count: 0, gross: 0, discount: 0, tax: 0, total: 0, cash: 0, upi: 0, card: 0, mixed: 0 }
    );
  }, [daySalesInvoices]);

  const rangeSalesInvoices = useMemo(() => {
    if (!state) return [];
    return state.invoices
      .filter((invoice) => {
        const key = dateKey(invoice.date);
        return key >= salesReportStart && key <= salesReportEnd;
      })
      .sort((first, second) => new Date(first.date) - new Date(second.date));
  }, [state, salesReportStart, salesReportEnd]);

  const rangeSalesSummary = useMemo(() => {
    const products = state?.products || [];
    return rangeSalesInvoices.reduce(
      (summary, invoice) => {
        const cost = invoice.items.reduce((total, item) => {
          const product = products.find((candidate) => candidate.id === item.productId || candidate.barcode === item.barcode);
          const unitCost = Number(item.cost ?? product?.cost ?? 0);
          return total + Math.max(0, Number(item.qty || 0) * unitCost);
        }, 0);
        summary.count += 1;
        summary.gross += Number(invoice.totals?.gross || 0);
        summary.discount += Number(invoice.totals?.discount || 0);
        summary.tax += Number(invoice.totals?.tax || 0);
        summary.total += Number(invoice.totals?.total || 0);
        summary.cost += cost;
        summary.profit += Number(invoice.totals?.total || 0) - cost;
        summary.cash += invoice.paymentMode === "Cash" ? Number(invoice.totals?.total || 0) : 0;
        summary.upi += invoice.paymentMode === "UPI" ? Number(invoice.totals?.total || 0) : 0;
        summary.card += invoice.paymentMode === "Card" ? Number(invoice.totals?.total || 0) : 0;
        summary.mixed += invoice.paymentMode === "Mixed" ? Number(invoice.totals?.total || 0) : 0;
        return summary;
      },
      { count: 0, gross: 0, discount: 0, tax: 0, total: 0, cost: 0, profit: 0, cash: 0, upi: 0, card: 0, mixed: 0 }
    );
  }, [rangeSalesInvoices, state?.products]);

  const returnInvoiceMatches = useMemo(() => {
    if (!state) return [];
    const query = returnSearch.trim().toLowerCase();
    if (!query) return state.invoices.slice().reverse().slice(0, 8);
    return state.invoices
      .slice()
      .reverse()
      .filter((invoice) =>
        [invoice.id, invoice.customer.name, invoice.customer.phone]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
      .slice(0, 8);
  }, [state, returnSearch]);

  const selectedReturnInvoice = useMemo(
    () => state?.invoices.find((invoice) => invoice.id === selectedReturnInvoiceId) || null,
    [state, selectedReturnInvoiceId]
  );

  const returnCredit = useMemo(() => {
    if (!selectedReturnInvoice || !state) return 0;
    return selectedReturnInvoice.items.reduce((sum, item, itemIndex) => {
      const qty = Math.max(0, Number(returnQuantities[itemIndex]) || 0);
      const unitCredit = Number(item.qty || 0) > 0 ? invoiceLineValue(selectedReturnInvoice, item) / Number(item.qty) : 0;
      return sum + unitCredit * qty;
    }, 0);
  }, [selectedReturnInvoice, returnQuantities, state]);

  const replacementTotal = useMemo(
    () => replacementItems.reduce((sum, item) => sum + lineTotal(item), 0),
    [replacementItems]
  );

  const replacementMatches = useMemo(() => {
    if (!state || !replacementSearch.trim()) return [];
    const query = replacementSearch.trim().toLowerCase();
    return state.products
      .filter((product) =>
        [product.name, product.barcode, product.sku]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
      .slice(0, 6);
  }, [state, replacementSearch]);

  function addProductToCart(product) {
    setCart((current) => {
      const existing = current.find((item) => item.productId === product.id);
      if (existing) {
        return current.map((item) => (item.productId === product.id ? { ...item, qty: Number(item.qty) + 1 } : item));
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          barcode: product.barcode,
          hsnCode: product.hsnCode || "",
          gstRate: Number(product.gstRate || 0),
          imageUrl: product.imageUrl || "",
          qty: 1,
          price: Number(product.price || 0),
          cost: Number(product.cost || 0),
          discount: 0,
          discountMode: "percentage",
          discountValue: 25,
        },
      ];
    });
    setSearch("");
    setBarcode("");
    barcodeRef.current?.focus();
  }

  function selectBillingCustomer(savedCustomer) {
    setCustomer({
      ...emptyCustomer,
      name: savedCustomer.name || "",
      phone: savedCustomer.phone || "",
      address: savedCustomer.address || "",
      gstin: savedCustomer.gstin || "",
      stateCode: savedCustomer.stateCode || "",
      whatsappOptIn: Boolean(savedCustomer.whatsappOptIn),
      whatsappOptInAt: savedCustomer.whatsappOptInAt || "",
    });
    setCustomerLookup("");
    showNotice(`${savedCustomer.name} linked`);
  }

  function exportCustomersCsv() {
    const rows = [
      ["Name", "Phone", "Address", "GSTIN", "State Code", "WhatsApp Opt In", "WhatsApp Opt In Date", "Invoice Count", "Total Spent", "Last Purchase"],
      ...state.customers.map((item) => [
        item.name,
        item.phone,
        item.address,
        item.gstin || "",
        item.stateCode || "",
        item.whatsappOptIn ? "Yes" : "No",
        item.whatsappOptInAt || "",
        item.invoiceCount,
        Number(item.totalSpent || 0).toFixed(2),
        item.lastPurchase || "",
      ]),
    ];
    downloadCsv(`alter-customers-${dateKey()}.csv`, rows);
  }

  function startEditCustomer(item) {
    setCustomerForm({
      key: item.key,
      name: item.name || "",
      phone: item.phone || "",
      address: item.address || "",
      gstin: item.gstin || "",
      stateCode: item.stateCode || "",
      whatsappOptIn: Boolean(item.whatsappOptIn),
      whatsappOptInAt: item.whatsappOptInAt || "",
    });
  }

  async function addCustomer(event) {
    event.preventDefault();
    try {
      const payload = {
        ...newCustomer,
        whatsappOptInAt: newCustomer.whatsappOptIn ? newCustomer.whatsappOptInAt || new Date().toISOString() : "",
      };
      const saved = await api("/api/customers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setNewCustomer(emptyCustomer);
      await loadState();
      showNotice(`${saved.name} added`);
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function saveCustomer(event) {
    event.preventDefault();
    if (!customerForm?.key) return;
    try {
      const saved = await api(`/api/customers/${encodeURIComponent(customerForm.key)}`, {
        method: "PUT",
        body: JSON.stringify(customerForm),
      });
      setCustomerForm(null);
      await loadState();
      showNotice(`${saved.name} updated`);
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function sendInvoiceWhatsApp(invoice) {
    if (!invoice.customer?.phone) {
      showNotice("Customer phone number is required for WhatsApp");
      return;
    }
    setSendingWhatsAppInvoiceId(invoice.id);
    try {
      await api("/api/whatsapp/send-invoice", {
        method: "POST",
        body: JSON.stringify({ invoiceId: invoice.id }),
      });
      showNotice(`Bill ${invoice.id} sent on WhatsApp`);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setSendingWhatsAppInvoiceId("");
    }
  }

  function selectWhatsAppCampaignImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      showNotice("Choose a PNG, JPEG, or WebP campaign image");
      event.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showNotice("Campaign image must be smaller than 5 MB");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setWhatsappCampaignImage({ name: file.name, data: String(reader.result) });
    };
    reader.readAsDataURL(file);
  }

  async function bulkOptInWhatsAppCustomers() {
    if (!bulkWhatsAppOptInChecked) {
      showNotice("Tick the bulk opt-in checkbox first");
      return;
    }
    const confirmed = window.confirm("Onboard all customers with phone numbers to WhatsApp promotions?");
    if (!confirmed) return;
    setIsBulkOptingIn(true);
    try {
      const result = await api("/api/customers/whatsapp-opt-in", {
        method: "POST",
        body: "{}",
      });
      await loadState();
      setBulkWhatsAppOptInChecked(false);
      showNotice(`${result.customers?.filter((item) => item.whatsappOptIn && item.phone).length || 0} customers onboarded to WhatsApp`);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setIsBulkOptingIn(false);
    }
  }

  async function sendWhatsAppCampaign(event) {
    event.preventDefault();
    const confirmed = window.confirm(`Send this WhatsApp message to ${whatsappOptedInCustomers.length} opted-in customers?`);
    if (!confirmed) return;
    setIsSendingCampaign(true);
    setWhatsappCampaignResult(null);
    try {
      const result = await api("/api/whatsapp/send-campaign", {
        method: "POST",
        body: JSON.stringify({ message: whatsappCampaignMessage, imageData: whatsappCampaignImage.data }),
      });
      setWhatsappCampaignResult(result);
      await loadState();
      showNotice(`WhatsApp campaign accepted: ${result.sent} accepted, ${result.failed} failed`);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setIsSendingCampaign(false);
    }
  }

  function setSalesRangePreset(preset) {
    const now = new Date();
    if (preset === "month") {
      setSalesReportStart(monthStartKey(now));
      setSalesReportEnd(monthEndKey(now));
      return;
    }
    if (preset === "quarter") {
      setSalesReportStart(quarterStartKey(now));
      setSalesReportEnd(quarterEndKey(now));
      return;
    }
    setSalesReportStart(dateKey(now));
    setSalesReportEnd(dateKey(now));
  }

  function exportSalesReportCsv() {
    if (!rangeSalesInvoices.length) {
      showNotice("No sales found in selected range");
      return;
    }
    const rows = [
      ["Invoice", "Date", "Customer", "Phone", "Type", "Payment", "Gross", "Discount", "Tax", "Total", "Cost", "Profit"],
      ...rangeSalesInvoices.map((invoice) => {
        const cost = invoice.items.reduce((total, item) => {
          const product = state.products.find((candidate) => candidate.id === item.productId || candidate.barcode === item.barcode);
          const unitCost = Number(item.cost ?? product?.cost ?? 0);
          return total + Math.max(0, Number(item.qty || 0) * unitCost);
        }, 0);
        const total = Number(invoice.totals?.total || 0);
        return [
          invoice.id,
          new Date(invoice.date).toLocaleString(),
          invoice.customer.name,
          invoice.customer.phone,
          invoice.invoiceType,
          invoice.paymentMode,
          Number(invoice.totals?.gross || 0).toFixed(2),
          Number(invoice.totals?.discount || 0).toFixed(2),
          Number(invoice.totals?.tax || 0).toFixed(2),
          total.toFixed(2),
          cost.toFixed(2),
          (total - cost).toFixed(2),
        ];
      }),
      [],
      ["Bills", rangeSalesSummary.count],
      ["Gross", rangeSalesSummary.gross.toFixed(2)],
      ["Discount", rangeSalesSummary.discount.toFixed(2)],
      ["Tax", rangeSalesSummary.tax.toFixed(2)],
      ["Net Sales", rangeSalesSummary.total.toFixed(2)],
      ["Cost", rangeSalesSummary.cost.toFixed(2)],
      ["Profit", rangeSalesSummary.profit.toFixed(2)],
      ["Cash", rangeSalesSummary.cash.toFixed(2)],
      ["UPI", rangeSalesSummary.upi.toFixed(2)],
      ["Card", rangeSalesSummary.card.toFixed(2)],
      ["Mixed", rangeSalesSummary.mixed.toFixed(2)],
    ];
    downloadCsv(`alter-sales-${salesReportStart}-to-${salesReportEnd}.csv`, rows);
  }

  function scanBarcode(event) {
    event.preventDefault();
    const code = barcode.trim();
    if (!code || !state) return;
    const product = state.products.find((item) => item.barcode === code || item.sku === code);
    if (!product) {
      showNotice(`No product found for barcode ${code}`);
      return;
    }
    addProductToCart(product);
  }

  function updateCartItem(index, patch) {
    setCart((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  }

  function removeCartItem(index) {
    setCart((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function availableReturnQty(invoice, itemIndex) {
    const purchased = Number(invoice.items[itemIndex]?.qty || 0);
    const returned = (state.returns || [])
      .filter((record) => record.invoiceId === invoice.id)
      .flatMap((record) => record.items)
      .filter((item) => item.itemIndex === itemIndex)
      .reduce((sum, item) => sum + Number(item.qty || 0), 0);
    return Math.max(0, purchased - returned);
  }

  function selectReturnInvoice(invoice) {
    setSelectedReturnInvoiceId(invoice.id);
    setReturnQuantities({});
    setReplacementItems([]);
    setReturnReason("");
    setReturnType("return");
  }

  function updateReturnQuantity(itemIndex, value) {
    if (!selectedReturnInvoice) return;
    const available = availableReturnQty(selectedReturnInvoice, itemIndex);
    const qty = Math.min(available, Math.max(0, Number(value) || 0));
    setReturnQuantities((current) => ({ ...current, [itemIndex]: qty }));
  }

  function addReplacementProduct(product) {
    setReplacementItems((current) => {
      const existing = current.find((item) => item.productId === product.id);
      if (existing) {
        return current.map((item) =>
          item.productId === product.id ? { ...item, qty: Number(item.qty) + 1 } : item
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          barcode: product.barcode,
          hsnCode: product.hsnCode || "",
          gstRate: Number(product.gstRate || 0),
          imageUrl: product.imageUrl || "",
          qty: 1,
          price: Number(product.price || 0),
          cost: Number(product.cost || 0),
          discountMode: "percentage",
          discountValue: 25,
          discount: 0,
        },
      ];
    });
    setReplacementSearch("");
  }

  async function addManualReplacement() {
    const name = exchangeManualItem.name.trim();
    const price = Math.max(0, Number(exchangeManualItem.price) || 0);
    const cost = Math.max(0, Number(exchangeManualItem.cost) || 0);
    const qty = Math.max(1, Number(exchangeManualItem.qty) || 1);
    if (!name || price <= 0) {
      showNotice("Replacement item name and price are required");
      return;
    }
    if (exchangeManualItem.saveToCatalog && !exchangeManualItem.barcode.trim()) {
      showNotice("Enter a barcode to save this replacement product");
      return;
    }

    try {
      let product = {
        id: `manual-exchange-${Date.now()}`,
        name,
        barcode: exchangeManualItem.barcode.trim(),
        category: exchangeManualItem.category.trim(),
        hsnCode: exchangeManualItem.hsnCode.trim(),
        gstRate: Number(exchangeManualItem.gstRate || 0),
        price,
        cost,
        imageUrl: "",
        manual: true,
      };

      if (exchangeManualItem.saveToCatalog) {
        product = await api("/api/products", {
          method: "POST",
          body: JSON.stringify({
            name,
            barcode: exchangeManualItem.barcode.trim(),
            category: exchangeManualItem.category.trim(),
            hsnCode: exchangeManualItem.hsnCode.trim(),
            gstRate: Number(exchangeManualItem.gstRate || 0),
            price,
            cost,
            stock: Math.max(0, Number(exchangeManualItem.stock) || 0),
          }),
        });
        await loadState();
      }

      setReplacementItems((current) => [
        ...current,
        {
          productId: product.id,
          name: product.name,
          barcode: product.barcode || "",
          hsnCode: product.hsnCode || "",
          gstRate: Number(product.gstRate || 0),
          imageUrl: product.imageUrl || "",
          qty,
          price,
          cost,
          discountMode: exchangeManualItem.discountMode,
          discountValue: Math.max(0, Number(exchangeManualItem.discountValue) || 0),
          discount: 0,
          manual: !exchangeManualItem.saveToCatalog,
        },
      ]);
      setExchangeManualItem(emptyManualItem);
      showNotice(exchangeManualItem.saveToCatalog ? "Replacement product saved and added" : "Manual replacement added");
    } catch (error) {
      showNotice(error.message);
    }
  }

  function updateReplacementItem(index, patch) {
    setReplacementItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    );
  }

  function startEditInvoice(invoice) {
    if (state.returns.some((record) => record.invoiceId === invoice.id)) {
      showNotice("Invoices with returns or exchanges cannot be edited");
      return;
    }
    setEditingInvoiceId(invoice.id);
    setActiveView("billing");
    setCustomer({ ...emptyCustomer, ...invoice.customer });
    setInvoiceType(invoice.invoiceType === "gst" ? "gst" : "regular");
    setGstType(invoice.gstType === "interstate" ? "interstate" : "intrastate");
    setPaymentMode(invoice.paymentMode || "Cash");
    setDiscountMode(invoice.totals?.discountMode === "percentage" ? "percentage" : "fixed");
    setDiscountValue(Number(invoice.totals?.discountValue || 0));
    setAmountPaid(Number(invoice.totals?.paid || invoice.totals?.total || 0));
    setCart(invoice.items.map((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId || candidate.barcode === item.barcode);
      return {
        ...item,
          imageUrl: product?.imageUrl || "",
          cost: Number(item.cost ?? product?.cost ?? 0),
          discountMode: item.discountMode === "fixed" ? "fixed" : "percentage",
        discountValue: Number(item.discountValue || 0),
      };
    }));
    setSearch("");
    setBarcode("");
    showNotice(`Editing ${invoice.id}`);
  }

  function printDaySales() {
    if (!daySalesInvoices.length) {
      showNotice("No sales found for selected date");
      return;
    }
    setLastInvoice(null);
    setLastReturn(null);
    setSalesPrint({
      date: salesPrintDate,
      invoices: daySalesInvoices,
      summary: daySalesSummary,
      shop: state.settings,
    });
    applyPrintPage("regular");
    window.setTimeout(() => window.print(), 100);
  }

  function cancelInvoiceEdit() {
    setEditingInvoiceId("");
    setCustomer(emptyCustomer);
    setCart([]);
    setAmountPaid(0);
    setDiscountMode("fixed");
    setDiscountValue(0);
    showNotice("Invoice edit cancelled");
  }

  async function deleteInvoice(invoice) {
    if (state.returns.some((record) => record.invoiceId === invoice.id)) {
      showNotice("Invoices with returns or exchanges cannot be deleted");
      return;
    }
    const confirmed = window.confirm(`Delete invoice ${invoice.id}? Stock and customer totals will be adjusted.`);
    if (!confirmed) return;
    try {
      await api(`/api/invoices/${encodeURIComponent(invoice.id)}`, { method: "DELETE" });
      await loadState();
      showNotice(`${invoice.id} deleted`);
    } catch (error) {
      showNotice(error.message);
    }
  }

  function printReturnSlip(record) {
    setLastInvoice(null);
    setSalesPrint(null);
    setLastReturn({
      ...record,
      shop: {
        ...(record.shop || state.settings),
        receiptFooter: state.settings.receiptFooter,
      },
    });
    applyPrintPage("regular");
    window.setTimeout(() => window.print(), 100);
  }

  async function submitReturn(event) {
    event.preventDefault();
    if (!selectedReturnInvoice) return;
    const items = selectedReturnInvoice.items
      .map((item, itemIndex) => ({ itemIndex, qty: Number(returnQuantities[itemIndex]) || 0 }))
      .filter((item) => item.qty > 0);
    try {
      const record = await api("/api/returns", {
        method: "POST",
        body: JSON.stringify({
          invoiceId: selectedReturnInvoice.id,
          type: returnType,
          items,
          replacements: replacementItems.map((item) => ({
            productId: item.productId,
            name: item.name,
            barcode: item.barcode,
            hsnCode: item.hsnCode,
            gstRate: item.gstRate,
            price: item.price,
            cost: item.cost,
            manual: item.manual,
            qty: item.qty,
            discount: lineDiscount(item),
            discountMode: item.discountMode,
            discountValue: item.discountValue,
          })),
          reason: returnReason,
          settlementMode,
        }),
      });
      setSelectedReturnInvoiceId("");
      setReturnQuantities({});
      setReplacementItems([]);
      setReturnSearch("");
      await loadState();
      showNotice(`${record.id} completed`);
      printReturnSlip(record);
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function addManualItem(event) {
    event.preventDefault();
    const name = manualItem.name.trim();
    const price = Math.max(0, Number(manualItem.price) || 0);
    const cost = Math.max(0, Number(manualItem.cost) || 0);
    const qty = Math.max(1, Number(manualItem.qty) || 1);
    if (!name || price <= 0) {
      showNotice("Manual item name and price are required");
      return;
    }
    if (manualItem.saveToCatalog && !manualItem.barcode.trim()) {
      showNotice("Enter a barcode to save this product");
      return;
    }
    if (invoiceType === "gst" && (!manualItem.hsnCode.trim() || Number(manualItem.gstRate || 0) <= 0)) {
      showNotice("GST items need an HSN code and GST rate");
      return;
    }

    try {
      let product = {
        id: `manual-${Date.now()}`,
        name,
        barcode: manualItem.barcode.trim(),
        category: manualItem.category.trim(),
        hsnCode: manualItem.hsnCode.trim(),
        gstRate: Number(manualItem.gstRate || 0),
        price,
        cost,
        imageUrl: "",
      };
      if (manualItem.saveToCatalog) {
        product = await api("/api/products", {
          method: "POST",
          body: JSON.stringify({
            name,
            barcode: manualItem.barcode.trim(),
            category: manualItem.category.trim(),
            hsnCode: manualItem.hsnCode.trim(),
            gstRate: Number(manualItem.gstRate || 0),
            price,
            cost,
            stock: Math.max(0, Number(manualItem.stock) || 0),
          }),
        });
        await loadState();
      }
      setCart((current) => [
        ...current,
        {
          productId: product.id,
          name: product.name,
          barcode: product.barcode,
          hsnCode: product.hsnCode || "",
          gstRate: Number(product.gstRate || 0),
          imageUrl: product.imageUrl || "",
          qty,
          price,
          cost,
          discount: 0,
          discountMode: manualItem.discountMode,
          discountValue: Math.max(0, Number(manualItem.discountValue) || 0),
        },
      ]);
      setManualItem(emptyManualItem);
      setManualItemOpen(false);
      showNotice(manualItem.saveToCatalog ? "Product saved and added to bill" : "Manual item added to bill");
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function saveProduct(event) {
    event.preventDefault();
    const saved = await api("/api/products", {
      method: "POST",
      body: JSON.stringify(productForm),
    });
    setProductForm(emptyProduct);
    await loadState();
    showNotice(`${saved.name} saved`);
  }

  function selectProductImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      showNotice("Choose a PNG, JPEG, or WebP image");
      event.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showNotice("Product image must be smaller than 5 MB");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setProductForm((current) => ({ ...current, imageData: String(reader.result), removeImage: false }));
    };
    reader.readAsDataURL(file);
  }

  function captureProductImage() {
    const video = cameraVideoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) {
      showNotice("Camera is still getting ready");
      return;
    }
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", 0.86);
    setProductForm((current) => ({ ...current, imageData, removeImage: false }));
    setCameraOpen(false);
  }

  async function deleteProduct(id) {
    const confirmed = window.confirm("Delete this product from the catalog?");
    if (!confirmed) return;
    await api(`/api/products/${id}`, { method: "DELETE" });
    await loadState();
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    await loadState();
    showNotice("Shop settings saved");
  }

  async function generateBill(event) {
    event.preventDefault();
    if (isBilling) return;
    if (!customer.name.trim()) {
      showNotice("Customer name is required");
      return;
    }
    if (!cart.length) {
      showNotice("Add a product by barcode scan or search");
      return;
    }
    if (invoiceType === "gst" && (!state.settings.firmName?.trim() || !(state.settings.firmGstin || state.settings.shopGstin)?.trim())) {
      showNotice("Configure the legal firm name and GSTIN in Settings");
      return;
    }
    if (invoiceType === "gst" && cart.some((item) => !item.hsnCode || Number(item.gstRate || 0) <= 0)) {
      showNotice("Every GST item needs an HSN code and GST rate");
      return;
    }
    const cartTaxable = cart.reduce((sum, item) => sum + lineTaxable(item), 0);
    const billDiscountRatio = cartTaxable > 0 ? totals.billDiscount / cartTaxable : 0;
    setIsBilling(true);
    try {
      const invoice = await api(editingInvoiceId ? `/api/invoices/${encodeURIComponent(editingInvoiceId)}` : "/api/invoices", {
        method: editingInvoiceId ? "PUT" : "POST",
        body: JSON.stringify({
          customer,
          items: cart.map((item) => {
            const taxable = Math.max(0, lineTaxable(item) * (1 - billDiscountRatio));
            return {
              ...item,
              discount: lineDiscount(item),
              taxable,
              gstAmount: invoiceType === "gst" ? taxable * (Number(item.gstRate || 0) / 100) : 0,
            };
          }),
          totals,
          paymentMode,
          invoiceType,
          gstType,
        }),
      });
      setLastReturn(null);
      setSalesPrint(null);
      setLastInvoice(invoice);
      applyPrintPage(invoice.invoiceType);
      setEditingInvoiceId("");
      setCustomer(emptyCustomer);
      setCustomerLookup("");
      setCart([]);
      setAmountPaid(0);
      setDiscountMode("fixed");
      setDiscountValue(0);
      await loadState();
      window.setTimeout(() => window.print(), 100);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setIsBilling(false);
    }
  }

  async function clearRecords() {
    const confirmed = window.confirm("Clear all saved customers and invoices? Products will remain.");
    if (!confirmed) return;
    await api("/api/clear-records", { method: "POST", body: "{}" });
    await loadState();
    showNotice("Customer and invoice records cleared");
  }

  if (!state) {
    return <main className="loading-screen">Loading TAARA Billing...</main>;
  }

  const viewTitle = {
    billing: "Counter billing",
    products: "Product barcodes",
    customers: "Customers",
    history: "Sales history",
    whatsapp: "WhatsApp inbox",
    returns: "Returns and exchanges",
    settings: "Settings",
  }[activeView];

  return (
    <>
      <main className="app-shell">
        <aside className="sidebar">
          <div className="brand-lockup">
            <img src="/taara-logo-dark-bg.png" alt="TAARA" />
            <span>Billing Desk</span>
          </div>
          <nav className="nav-tabs" aria-label="Main sections">
            {[
              ["billing", "Bill"],
              ["products", "Products"],
              ["customers", "Customers"],
              ["history", "Sales"],
              ["whatsapp", "WhatsApp"],
              ["returns", "Returns"],
              ["settings", "Settings"],
            ].map(([key, label]) => (
              <button key={key} className={activeView === key ? "active" : ""} onClick={() => setActiveView(key)} type="button">
                {label}
              </button>
            ))}
          </nav>
          <section className="today-panel">
            <span>Today</span>
            <strong>{money(todaySummary.total)}</strong>
            <small>{todaySummary.count} bills generated</small>
          </section>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div>
              <p>TAARA billing software</p>
              <h1>{viewTitle}</h1>
            </div>
            <div className="status-pill">{notice || `${state.products.length} products ready`}</div>
          </header>

          {activeView === "billing" && (
            <form className="billing-grid" onSubmit={generateBill}>
              <section className="panel scan-panel">
                <div className="panel-title">
                  <h2>{editingInvoiceId ? `Edit ${editingInvoiceId}` : "Scan or search"}</h2>
                  <div className="panel-actions">
                    {editingInvoiceId && (
                      <button className="quiet-button" type="button" onClick={cancelInvoiceEdit}>
                        Cancel edit
                      </button>
                    )}
                    <button className="secondary-button" type="button" onClick={() => setManualItemOpen(true)}>
                      Manual item
                    </button>
                    <button className="quiet-button" type="button" onClick={() => barcodeRef.current?.focus()}>
                      Focus scanner
                    </button>
                  </div>
                </div>
                <div className="invoice-mode">
                  <span>Invoice type</span>
                  <div className="segmented-control">
                    <button className={invoiceType === "regular" ? "active" : ""} type="button" onClick={() => setInvoiceType("regular")}>
                      Regular
                    </button>
                    <button className={invoiceType === "gst" ? "active" : ""} type="button" onClick={() => setInvoiceType("gst")}>
                      GST invoice
                    </button>
                  </div>
                  {invoiceType === "gst" && (
                    <select aria-label="GST supply type" value={gstType} onChange={(event) => setGstType(event.target.value)}>
                      <option value="intrastate">Within state (CGST + SGST)</option>
                      <option value="interstate">Other state (IGST)</option>
                    </select>
                  )}
                </div>
                <div className="scan-layout">
                  <label>
                    Barcode scanner
                    <div className="barcode-form">
                      <input
                        ref={barcodeRef}
                        value={barcode}
                        onChange={(event) => setBarcode(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") scanBarcode(event);
                        }}
                        placeholder="Scan barcode and press Enter"
                        autoFocus
                      />
                      <button type="button" onClick={scanBarcode}>Add</button>
                    </div>
                  </label>
                  <label>
                    Product search
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, SKU, barcode" />
                  </label>
                </div>
                <div className="product-results">
                  {filteredProducts.map((product) => (
                    <button key={product.id} className="product-result" type="button" onClick={() => addProductToCart(product)}>
                      <ProductImage product={product} />
                      <span className="product-result-copy">
                        <strong>{product.name}</strong>
                        <small>{product.barcode} · Stock {product.stock}</small>
                      </span>
                      <b>{money(product.price)}</b>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel customer-panel">
                <div className="panel-title">
                  <h2>Customer</h2>
                </div>
                <label className="customer-lookup">
                  Search saved customer
                  <input
                    value={customerLookup}
                    onChange={(event) => setCustomerLookup(event.target.value)}
                    placeholder="Name, phone, or address"
                  />
                </label>
                {billingCustomerMatches.length > 0 && (
                  <div className="customer-match-list">
                    {billingCustomerMatches.map((item) => (
                      <button type="button" key={item.key} onClick={() => selectBillingCustomer(item)}>
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.phone || "No phone"} · {item.invoiceCount} bills · {money(item.totalSpent)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="field-grid">
                  <label>
                    Name
                    <input value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} required />
                  </label>
                  <label>
                    Phone
                    <input value={customer.phone} onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} />
                  </label>
                  <label className="checkbox-row wide-field">
                    <input
                      type="checkbox"
                      checked={customer.whatsappOptIn}
                      onChange={(event) =>
                        setCustomer({
                          ...customer,
                          whatsappOptIn: event.target.checked,
                          whatsappOptInAt: event.target.checked ? customer.whatsappOptInAt || new Date().toISOString() : "",
                        })
                      }
                    />
                    Allow WhatsApp bills and promotional messages
                  </label>
                  {phoneCustomerMatches.length > 0 && (
                    <div className="customer-match-list phone-match-list">
                      {phoneCustomerMatches.map((item) => (
                        <button type="button" key={item.key} onClick={() => selectBillingCustomer(item)}>
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.phone || "No phone"} · {item.invoiceCount} bills · {money(item.totalSpent)}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="wide-field">
                    Address
                    <textarea rows="2" value={customer.address} onChange={(event) => setCustomer({ ...customer, address: event.target.value })} />
                  </label>
                  {invoiceType === "gst" && (
                    <>
                      <label>
                        Customer GSTIN
                        <input value={customer.gstin} onChange={(event) => setCustomer({ ...customer, gstin: event.target.value.toUpperCase() })} />
                      </label>
                      <label>
                        State code
                        <input maxLength="2" value={customer.stateCode} onChange={(event) => setCustomer({ ...customer, stateCode: event.target.value })} />
                      </label>
                    </>
                  )}
                </div>
              </section>

              <section className="panel cart-panel">
                <div className="panel-title">
                  <h2>Bill items</h2>
                  <span>{cart.length} lines</span>
                </div>
                <div className="cart-table">
                  <div className="cart-head">
                    <span>Product</span>
                    <span>Qty</span>
                    <span>Price</span>
                    <span>Discount</span>
                    <span>Total</span>
                    <span></span>
                  </div>
                  {cart.length ? (
                    cart.map((item, index) => (
                      <div className="cart-row" key={`${item.productId}-${index}`}>
                        <div className="cart-product">
                          <ProductImage product={item} compact />
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.barcode}</small>
                          </span>
                        </div>
                        <input min="1" type="number" value={item.qty} onChange={(event) => updateCartItem(index, { qty: Number(event.target.value) })} />
                        <input min="0" type="number" value={item.price} onChange={(event) => updateCartItem(index, { price: Number(event.target.value) })} />
                        <div className="line-discount-control">
                          <select
                            aria-label={`${item.name} discount type`}
                            value={item.discountMode}
                            onChange={(event) => updateCartItem(index, { discountMode: event.target.value })}
                          >
                            <option value="percentage">%</option>
                            <option value="fixed">₹</option>
                          </select>
                          <input
                            aria-label={`${item.name} discount value`}
                            min="0"
                            max={item.discountMode === "percentage" ? "100" : undefined}
                            step="0.01"
                            type="number"
                            value={item.discountValue}
                            onChange={(event) => updateCartItem(index, { discountValue: Number(event.target.value) })}
                          />
                        </div>
                        <strong>{money(lineTotal(item))}</strong>
                        <button type="button" onClick={() => removeCartItem(index)}>
                          x
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state">Scan a barcode or choose a product to start the bill.</div>
                  )}
                </div>
              </section>

              <section className="panel totals-panel">
                <div className="panel-title">
                  <h2>Payment</h2>
                  <span>{editingInvoiceId || `${state.settings.invoicePrefix}-${String(state.invoices.length + 1).padStart(5, "0")}`}</span>
                </div>
                <div className="field-grid compact">
                  <label>
                    Bill discount type
                    <select value={discountMode} onChange={(event) => setDiscountMode(event.target.value)}>
                      <option value="fixed">Fixed amount</option>
                      <option value="percentage">Percentage</option>
                    </select>
                  </label>
                  <label>
                    {discountMode === "percentage" ? "Additional discount %" : "Additional discount amount"}
                    <input
                      min="0"
                      max={discountMode === "percentage" ? "100" : undefined}
                      step="0.01"
                      type="number"
                      value={discountValue}
                      onChange={(event) => setDiscountValue(event.target.value)}
                    />
                  </label>
                  <label>
                    Payment
                    <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
                      <option>Cash</option>
                      <option>UPI</option>
                      <option>Card</option>
                      <option>Mixed</option>
                    </select>
                  </label>
                  <label>
                    Paid
                    <input min="0" step="0.01" type="number" value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} />
                  </label>
                </div>
                <Totals totals={totals} invoiceType={invoiceType} gstType={gstType} />
                <button className="primary-button" type="submit" disabled={isBilling}>
                  {isBilling ? "Processing..." : editingInvoiceId ? "Update invoice" : invoiceType === "gst" ? "Generate A4 GST invoice" : "Generate 2 inch bill"}
                </button>
              </section>
            </form>
          )}

          {activeView === "products" && (
            <section className="catalog-grid">
              <form className="panel" onSubmit={saveProduct}>
                <div className="panel-title">
                  <h2>{productForm.id ? "Edit product" : "Add product"}</h2>
                  <button className="quiet-button" type="button" onClick={() => setProductForm(emptyProduct)}>
                    Clear
                  </button>
                </div>
                <div className="field-grid">
                  <div className="product-image-editor wide-field">
                    <div className="product-image-preview">
                      {productForm.imageData || (productForm.imageUrl && !productForm.removeImage) ? (
                        <img src={productForm.imageData || productForm.imageUrl} alt={`${productForm.name || "Product"} preview`} />
                      ) : (
                        <span>No image</span>
                      )}
                    </div>
                    <div className="product-image-actions">
                      <div className="image-source-actions">
                        <button className="secondary-button" type="button" onClick={() => setCameraOpen(true)}>
                          Take photo
                        </button>
                        <label className="upload-image-button">
                          Upload image
                          <input
                            key={`${productForm.id}-${productForm.imageData ? "selected" : "empty"}`}
                            accept="image/png,image/jpeg,image/webp"
                            type="file"
                            onChange={selectProductImage}
                          />
                        </label>
                      </div>
                      <small className="image-help">
                        PNG, JPEG, or WebP. Maximum 5 MB.
                      </small>
                      {(productForm.imageData || productForm.imageUrl) && !productForm.removeImage && (
                        <button
                          className="quiet-danger"
                          type="button"
                          onClick={() => setProductForm({ ...productForm, imageData: "", imageUrl: productForm.imageUrl, removeImage: true })}
                        >
                          Remove image
                        </button>
                      )}
                    </div>
                  </div>
                  <label>
                    Product name
                    <input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} required />
                  </label>
                  <label>
                    Barcode
                    <input value={productForm.barcode} onChange={(event) => setProductForm({ ...productForm, barcode: event.target.value })} required />
                  </label>
                  <label>
                    SKU
                    <input value={productForm.sku} onChange={(event) => setProductForm({ ...productForm, sku: event.target.value })} />
                  </label>
                  <label>
                    Category
                    <input value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })} />
                  </label>
                  <label>
                    HSN code
                    <input value={productForm.hsnCode || ""} onChange={(event) => setProductForm({ ...productForm, hsnCode: event.target.value })} />
                  </label>
                  <label>
                    GST rate %
                    <input min="0" step="0.01" type="number" value={productForm.gstRate ?? ""} onChange={(event) => setProductForm({ ...productForm, gstRate: event.target.value })} />
                  </label>
                  <label>
                    Price
                    <input min="0" type="number" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} required />
                  </label>
                  <label>
                    Cost
                    <input min="0" step="0.01" type="number" value={productForm.cost ?? ""} onChange={(event) => setProductForm({ ...productForm, cost: event.target.value })} />
                  </label>
                  <label>
                    Stock
                    <input min="0" type="number" value={productForm.stock} onChange={(event) => setProductForm({ ...productForm, stock: event.target.value })} />
                  </label>
                </div>
                <button className="primary-button" type="submit">
                  Save product
                </button>
              </form>
              <section className="panel product-list-panel">
                <div className="catalog-list-heading">
                  <div>
                    <h2>Product list</h2>
                    <span>{catalogProducts.length} of {state.products.length} items</span>
                  </div>
                </div>
                <div className="catalog-toolbar">
                  <label className="catalog-search">
                    Search products
                    <input
                      value={catalogSearch}
                      onChange={(event) => setCatalogSearch(event.target.value)}
                      placeholder="Name, barcode, SKU, category, HSN"
                    />
                  </label>
                  <label>
                    Stock
                    <select value={catalogStockFilter} onChange={(event) => setCatalogStockFilter(event.target.value)}>
                      <option value="all">All stock</option>
                      <option value="in-stock">In stock</option>
                      <option value="out-of-stock">Out of stock</option>
                    </select>
                  </label>
                </div>
                <div className="data-list product-catalog-list">
                  {catalogProducts.map((product) => (
                    <article className="data-card product-data-card" key={product.id}>
                      <ProductImage product={product} />
                      <div className="product-card-content">
                        <div className="product-card-title">
                          <strong>{product.name}</strong>
                          <b>{money(product.price)}</b>
                        </div>
                        <span className="product-card-code">{product.barcode}{product.sku ? ` · ${product.sku}` : ""}</span>
                        <div className="product-card-meta">
                          <span>{product.category || "Uncategorised"}</span>
                          <span>HSN {product.hsnCode || "Not set"}</span>
                          <span>GST {product.gstRate || 0}%</span>
                          <span>Cost {money(product.cost || 0)}</span>
                          <span className={Number(product.stock) > 0 ? "stock-ok" : "stock-empty"}>Stock {product.stock}</span>
                        </div>
                      </div>
                      <div className="card-actions product-card-actions">
                        <button type="button" onClick={() => setProductForm({ ...product, imageData: "", removeImage: false })}>Edit</button>
                        <button type="button" onClick={() => deleteProduct(product.id)}>Delete</button>
                      </div>
                    </article>
                  ))}
                  {!catalogProducts.length && (
                    <div className="empty-state">No products match your search.</div>
                  )}
                </div>
              </section>
            </section>
          )}

          {activeView === "customers" && (
            <section className="customer-stack">
              <section className="panel export-panel">
                <div className="panel-title">
                  <h2>Customer exports</h2>
                  <div className="panel-actions">
                    <button className="secondary-button" type="button" onClick={exportCustomersCsv}>Download CSV</button>
                    <a className="secondary-link" href="/api/customers/export.csv">Server CSV</a>
                  </div>
                </div>
                <p className="panel-note">Use this CSV in Excel or your messaging tool for promotional campaigns.</p>
              </section>
              <form className="panel" onSubmit={addCustomer}>
                <div className="panel-title">
                  <h2>Add customer</h2>
                  <button className="quiet-button" type="button" onClick={() => setNewCustomer(emptyCustomer)}>Clear</button>
                </div>
                <div className="field-grid">
                  <label>
                    Name
                    <input value={newCustomer.name} onChange={(event) => setNewCustomer({ ...newCustomer, name: event.target.value })} required />
                  </label>
                  <label>
                    Phone
                    <input value={newCustomer.phone} onChange={(event) => setNewCustomer({ ...newCustomer, phone: event.target.value })} />
                  </label>
                  <label className="checkbox-row wide-field">
                    <input
                      type="checkbox"
                      checked={newCustomer.whatsappOptIn}
                      onChange={(event) =>
                        setNewCustomer({
                          ...newCustomer,
                          whatsappOptIn: event.target.checked,
                          whatsappOptInAt: event.target.checked ? newCustomer.whatsappOptInAt || new Date().toISOString() : "",
                        })
                      }
                    />
                    Allow WhatsApp bills and promotional messages
                  </label>
                  <label className="wide-field">
                    Address
                    <textarea rows="2" value={newCustomer.address} onChange={(event) => setNewCustomer({ ...newCustomer, address: event.target.value })} />
                  </label>
                  <label>
                    GSTIN
                    <input value={newCustomer.gstin} onChange={(event) => setNewCustomer({ ...newCustomer, gstin: event.target.value.toUpperCase() })} />
                  </label>
                  <label>
                    State code
                    <input maxLength="2" value={newCustomer.stateCode} onChange={(event) => setNewCustomer({ ...newCustomer, stateCode: event.target.value })} />
                  </label>
                </div>
                <button className="primary-button" type="submit">Add customer</button>
              </form>
              <form className="panel whatsapp-panel" onSubmit={sendWhatsAppCampaign}>
                <div className="panel-title">
                  <div>
                    <h2>WhatsApp promotions</h2>
                    <span>{whatsappOptedInCustomers.length} opted-in customers</span>
                  </div>
                  <span className={whatsappStatus.configured ? "status-badge success" : "status-badge warning"}>
                    {whatsappStatus.configured ? "Configured" : "Needs setup"}
                  </span>
                </div>
                <div className="bulk-whatsapp-box">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={bulkWhatsAppOptInChecked}
                      onChange={(event) => setBulkWhatsAppOptInChecked(event.target.checked)}
                    />
                    Onboard all current customers with phone numbers to WhatsApp promotions
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!bulkWhatsAppOptInChecked || isBulkOptingIn}
                    onClick={bulkOptInWhatsAppCustomers}
                  >
                    {isBulkOptingIn ? "Onboarding..." : "Onboard all customers"}
                  </button>
                </div>
                <label>
                  Campaign note
                  <textarea
                    rows="4"
                    value={whatsappCampaignMessage}
                    onChange={(event) => setWhatsappCampaignMessage(event.target.value)}
                    placeholder="Internal note for this campaign"
                  />
                </label>
                <div className="campaign-image-field">
                  <label>
                    Promotional image
                    <input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectWhatsAppCampaignImage} />
                  </label>
                  {whatsappCampaignImage.data && (
                    <div className="campaign-image-preview">
                      <img src={whatsappCampaignImage.data} alt="Campaign attachment preview" />
                      <div>
                        <strong>{whatsappCampaignImage.name}</strong>
                        <button className="quiet-button" type="button" onClick={() => setWhatsappCampaignImage({ name: "", data: "" })}>
                          Remove image
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <p className="panel-note">TAARA sends the approved Meta template alter_new_arrivals to opted-in customers. The selected image is sent as the template header when attached.</p>
                <button className="primary-button" type="submit" disabled={isSendingCampaign || !whatsappOptedInCustomers.length}>
                  {isSendingCampaign ? "Sending..." : "Send WhatsApp campaign"}
                </button>
                {whatsappCampaignResult && (
                  <div className="campaign-result">
                    <strong>{whatsappCampaignResult.sent} accepted · {whatsappCampaignResult.failed} failed · {whatsappCampaignResult.attempted || 0} attempted</strong>
                    <div className="campaign-result-list">
                      {(whatsappCampaignResult.results || []).map((result) => (
                        <div className="campaign-result-row" key={`${result.key}-${result.normalizedPhone || result.phone}`}>
                          <span>
                            <strong>{result.name || "Customer"}</strong>
                            <small>{result.phone || "No phone"} → {result.normalizedPhone || "Invalid"}</small>
                          </span>
                          <span className={result.ok ? "status-badge success" : "status-badge warning"}>
                            {result.ok ? "Accepted" : "Failed"}
                          </span>
                          <small>{result.ok ? result.messageId || "Queued by Meta" : [result.error, result.errorCode && `Code ${result.errorCode}`].filter(Boolean).join(" · ")}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </form>
              {customerForm && (
                <form className="panel" onSubmit={saveCustomer}>
                  <div className="panel-title">
                    <h2>Edit customer</h2>
                    <button className="quiet-button" type="button" onClick={() => setCustomerForm(null)}>Cancel</button>
                  </div>
                  <div className="field-grid">
                    <label>
                      Name
                      <input value={customerForm.name} onChange={(event) => setCustomerForm({ ...customerForm, name: event.target.value })} required />
                    </label>
                    <label>
                      Phone
                      <input value={customerForm.phone} onChange={(event) => setCustomerForm({ ...customerForm, phone: event.target.value })} />
                    </label>
                    <label className="checkbox-row wide-field">
                      <input
                        type="checkbox"
                        checked={customerForm.whatsappOptIn}
                        onChange={(event) =>
                          setCustomerForm({
                            ...customerForm,
                            whatsappOptIn: event.target.checked,
                            whatsappOptInAt: event.target.checked ? customerForm.whatsappOptInAt || new Date().toISOString() : "",
                          })
                        }
                      />
                      Allow WhatsApp bills and promotional messages
                    </label>
                    <label className="wide-field">
                      Address
                      <textarea rows="2" value={customerForm.address} onChange={(event) => setCustomerForm({ ...customerForm, address: event.target.value })} />
                    </label>
                    <label>
                      GSTIN
                      <input value={customerForm.gstin} onChange={(event) => setCustomerForm({ ...customerForm, gstin: event.target.value.toUpperCase() })} />
                    </label>
                    <label>
                      State code
                      <input maxLength="2" value={customerForm.stateCode} onChange={(event) => setCustomerForm({ ...customerForm, stateCode: event.target.value })} />
                    </label>
                  </div>
                  <button className="primary-button" type="submit">Save customer</button>
                </form>
              )}
              <ListPanel title="Customers" search={customerSearch} setSearch={setCustomerSearch} placeholder="Search customers">
                {filteredCustomers.length ? filteredCustomers.map((item) => (
                  <article className="customer-card" key={item.key}>
                    <div className="customer-card-primary">
                      <strong>{item.name}</strong>
                      <span>{item.invoiceCount} bills · {money(item.totalSpent)}</span>
                    </div>
                    <div className="customer-card-details">
                      <span>{item.phone || "No phone"}</span>
                      <span>{item.address || "No address saved"}</span>
                    </div>
                    <div className="customer-card-actions">
                      <span className={item.whatsappOptIn ? "status-badge success" : "status-badge muted"}>
                        {item.whatsappOptIn ? "WhatsApp yes" : "WhatsApp no"}
                      </span>
                      <button className="quiet-button" type="button" onClick={() => startEditCustomer(item)}>Edit</button>
                    </div>
                  </article>
                )) : <div className="empty-state">No customers saved yet.</div>}
              </ListPanel>
            </section>
          )}

          {activeView === "history" && (
            <section className="sales-stack">
              <section className="panel sales-report-panel">
                <div className="panel-title">
                  <h2>Sales / P&L report</h2>
                  <button className="secondary-button" type="button" onClick={exportSalesReportCsv}>Export CSV</button>
                </div>
                <div className="sales-range-controls">
                  <label>
                    From
                    <input type="date" value={salesReportStart} onChange={(event) => setSalesReportStart(event.target.value)} />
                  </label>
                  <label>
                    To
                    <input type="date" value={salesReportEnd} onChange={(event) => setSalesReportEnd(event.target.value)} />
                  </label>
                  <div className="panel-actions">
                    <button className="quiet-button" type="button" onClick={() => setSalesRangePreset("today")}>Today</button>
                    <button className="quiet-button" type="button" onClick={() => setSalesRangePreset("month")}>This month</button>
                    <button className="quiet-button" type="button" onClick={() => setSalesRangePreset("quarter")}>This quarter</button>
                  </div>
                </div>
                <div className="sales-report-grid">
                  <div><span>Bills</span><strong>{rangeSalesSummary.count}</strong></div>
                  <div><span>Gross</span><strong>{money(rangeSalesSummary.gross)}</strong></div>
                  <div><span>Discount</span><strong>{money(rangeSalesSummary.discount)}</strong></div>
                  <div><span>Tax</span><strong>{money(rangeSalesSummary.tax)}</strong></div>
                  <div><span>Net sales</span><strong>{money(rangeSalesSummary.total)}</strong></div>
                  <div><span>Cost</span><strong>{money(rangeSalesSummary.cost)}</strong></div>
                  <div><span>Profit</span><strong>{money(rangeSalesSummary.profit)}</strong></div>
                </div>
              </section>
              <section className="panel sales-day-panel">
                <div className="panel-title">
                  <h2>Day wise sales print</h2>
                  <button className="secondary-button" type="button" onClick={printDaySales}>Print day receipt</button>
                </div>
                <div className="sales-day-controls">
                  <label>
                    Sales date
                    <input type="date" value={salesPrintDate} onChange={(event) => setSalesPrintDate(event.target.value)} />
                  </label>
                  <div className="sales-day-total">
                    <span>{daySalesSummary.count} bills</span>
                    <strong>{money(daySalesSummary.total)}</strong>
                  </div>
                </div>
              </section>
              <ListPanel title="Sales history" search={invoiceSearch} setSearch={setInvoiceSearch} placeholder="Search invoices">
                {filteredInvoices.length ? filteredInvoices.map((invoice) => (
                  <article className="data-card" key={invoice.id}>
                    <div>
                      <strong>{invoice.id} · {invoice.customer.name}</strong>
                      <span>{invoice.invoiceType === "gst" ? "GST" : "Regular"} · {new Date(invoice.date).toLocaleString()} · {invoice.paymentMode} · {money(invoice.totals.total)}</span>
                    </div>
                    <div className="card-actions">
                      <button type="button" onClick={() => startEditInvoice(invoice)}>Edit</button>
                      <button
                        type="button"
                        onClick={() => {
                          setLastReturn(null);
                          setSalesPrint(null);
                          setLastInvoice({
                            ...invoice,
                            shop: {
                              ...invoice.shop,
                              receiptFooter: state.settings.receiptFooter,
                            },
                          });
                          applyPrintPage(invoice.invoiceType);
                          window.setTimeout(() => window.print(), 100);
                        }}
                      >
                        Print
                      </button>
                      <button
                        type="button"
                        disabled={sendingWhatsAppInvoiceId === invoice.id}
                        onClick={() => sendInvoiceWhatsApp(invoice)}
                      >
                        {sendingWhatsAppInvoiceId === invoice.id ? "Sending..." : "WhatsApp"}
                      </button>
                      <button className="quiet-danger" type="button" onClick={() => deleteInvoice(invoice)}>Delete</button>
                    </div>
                  </article>
                )) : <div className="empty-state">No invoices generated yet.</div>}
              </ListPanel>
            </section>
          )}

          {activeView === "whatsapp" && (
            <section className="whatsapp-inbox-stack">
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <h2>WhatsApp inbox</h2>
                    <span>{(state.whatsappMessages || []).length} webhook events</span>
                  </div>
                  <button className="secondary-button" type="button" onClick={loadState}>Refresh</button>
                </div>
                <p className="panel-note">
                  Incoming replies appear here after Meta webhooks are configured. Delivery/read events also show as status updates.
                </p>
              </section>
              <ListPanel title="Messages" search={whatsappInboxSearch} setSearch={setWhatsappInboxSearch} placeholder="Search WhatsApp messages">
                {filteredWhatsappMessages.length ? filteredWhatsappMessages.map((message) => (
                  <article className={`data-card whatsapp-message-card ${message.direction}`} key={`${message.id}-${message.timestamp}`}>
                    <div>
                      <strong>
                        {message.customerName || message.from || message.to || "WhatsApp"}
                      </strong>
                      <span>
                        {message.direction === "incoming" ? `From ${message.from}` : message.direction === "outgoing" ? `To ${message.to}` : `Status for ${message.to}`}
                        {" · "}
                        {new Date(message.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <span className="whatsapp-message-text">{message.text}</span>
                    <span className={message.direction === "incoming" ? "status-badge success" : message.direction === "outgoing" ? "status-badge warning" : "status-badge muted"}>
                      {message.direction === "incoming" ? message.type : message.status || "status"}
                    </span>
                  </article>
                )) : <div className="empty-state">No WhatsApp messages yet.</div>}
              </ListPanel>
            </section>
          )}

          {activeView === "returns" && (
            <section className="returns-layout">
              <section className="panel return-lookup-panel">
                <div className="panel-title">
                  <h2>Find original invoice</h2>
                </div>
                <label>
                  Invoice or customer
                  <input
                    value={returnSearch}
                    onChange={(event) => setReturnSearch(event.target.value)}
                    placeholder="Invoice number, name, phone"
                  />
                </label>
                <div className="return-invoice-list">
                  {returnInvoiceMatches.map((invoice) => (
                    <button
                      className={selectedReturnInvoiceId === invoice.id ? "return-invoice-result active" : "return-invoice-result"}
                      key={invoice.id}
                      type="button"
                      onClick={() => selectReturnInvoice(invoice)}
                    >
                      <strong>{invoice.id}</strong>
                      <span>{invoice.customer.name} · {new Date(invoice.date).toLocaleDateString("en-IN")}</span>
                      <b>{money(invoice.totals.total)}</b>
                    </button>
                  ))}
                  {!returnInvoiceMatches.length && <div className="empty-state">No matching invoices.</div>}
                </div>
              </section>

              {selectedReturnInvoice ? (
                <form className="panel return-workbench" onSubmit={submitReturn}>
                  <div className="panel-title">
                    <div>
                      <h2>{selectedReturnInvoice.id}</h2>
                      <span>{selectedReturnInvoice.customer.name} · {selectedReturnInvoice.customer.phone || "No phone"}</span>
                    </div>
                    <div className="segmented-control return-mode-control">
                      <button className={returnType === "return" ? "active" : ""} type="button" onClick={() => { setReturnType("return"); setReplacementItems([]); }}>
                        Return
                      </button>
                      <button className={returnType === "exchange" ? "active" : ""} type="button" onClick={() => setReturnType("exchange")}>
                        Exchange
                      </button>
                    </div>
                  </div>

                  <div className="return-items-table">
                    <div className="return-items-head">
                      <span>Sold item</span>
                      <span>Purchased</span>
                      <span>Available</span>
                      <span>Return qty</span>
                      <span>Credit</span>
                    </div>
                    {selectedReturnInvoice.items.map((item, itemIndex) => {
                      const available = availableReturnQty(selectedReturnInvoice, itemIndex);
                      const selectedQty = Number(returnQuantities[itemIndex]) || 0;
                      const unitCredit = Number(item.qty || 0) > 0
                        ? invoiceLineValue(selectedReturnInvoice, item) / Number(item.qty)
                        : 0;
                      return (
                        <div className="return-item-row" key={`${item.barcode}-${itemIndex}`}>
                          <div><strong>{item.name}</strong><small>{item.barcode || "Manual item"}</small></div>
                          <span>{item.qty}</span>
                          <span>{available}</span>
                          <input
                            aria-label={`Return quantity for ${item.name}`}
                            disabled={available === 0}
                            max={available}
                            min="0"
                            type="number"
                            value={selectedQty}
                            onChange={(event) => updateReturnQuantity(itemIndex, event.target.value)}
                          />
                          <strong>{money(unitCredit * selectedQty)}</strong>
                        </div>
                      );
                    })}
                  </div>

                  {returnType === "exchange" && (
                    <section className="exchange-section">
                      <div className="panel-title">
                        <h2>Replacement products</h2>
                      </div>
                      <label>
                        Search replacement
                        <input
                          value={replacementSearch}
                          onChange={(event) => setReplacementSearch(event.target.value)}
                          placeholder="Product name, barcode, SKU"
                        />
                      </label>
                      {replacementMatches.length > 0 && (
                        <div className="replacement-results">
                          {replacementMatches.map((product) => (
                            <button type="button" key={product.id} onClick={() => addReplacementProduct(product)}>
                              <ProductImage product={product} compact />
                              <span><strong>{product.name}</strong><small>{product.barcode} · Stock {product.stock}</small></span>
                              <b>{money(product.price)}</b>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="exchange-manual-form">
                        <div className="panel-title compact-title">
                          <h3>Manual replacement</h3>
                        </div>
                        <div className="field-grid compact-fields">
                          <label>
                            Item name
                            <input
                              value={exchangeManualItem.name}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, name: event.target.value })}
                              placeholder="Unregistered product"
                            />
                          </label>
                          <label>
                            Qty
                            <input
                              min="1"
                              type="number"
                              value={exchangeManualItem.qty}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, qty: event.target.value })}
                            />
                          </label>
                          <label>
                            Price
                            <input
                              min="0"
                              step="0.01"
                              type="number"
                              value={exchangeManualItem.price}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, price: event.target.value })}
                            />
                          </label>
                          <label>
                            Cost optional
                            <input
                              min="0"
                              step="0.01"
                              type="number"
                              value={exchangeManualItem.cost}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, cost: event.target.value })}
                              placeholder="For profit report"
                            />
                          </label>
                          <label>
                            Discount type
                            <select
                              value={exchangeManualItem.discountMode}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, discountMode: event.target.value })}
                            >
                              <option value="percentage">Percentage</option>
                              <option value="fixed">Fixed amount</option>
                            </select>
                          </label>
                          <label>
                            {exchangeManualItem.discountMode === "percentage" ? "Discount %" : "Discount amount"}
                            <input
                              min="0"
                              max={exchangeManualItem.discountMode === "percentage" ? "100" : undefined}
                              step="0.01"
                              type="number"
                              value={exchangeManualItem.discountValue}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, discountValue: event.target.value })}
                            />
                          </label>
                          <label>
                            Barcode
                            <input
                              value={exchangeManualItem.barcode}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, barcode: event.target.value })}
                              placeholder="Optional unless saving"
                            />
                          </label>
                          <label>
                            Category
                            <input
                              value={exchangeManualItem.category}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, category: event.target.value })}
                            />
                          </label>
                          <label>
                            HSN code
                            <input
                              value={exchangeManualItem.hsnCode}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, hsnCode: event.target.value })}
                            />
                          </label>
                          <label>
                            GST rate %
                            <input
                              min="0"
                              step="0.01"
                              type="number"
                              value={exchangeManualItem.gstRate}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, gstRate: event.target.value })}
                            />
                          </label>
                        </div>
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={exchangeManualItem.saveToCatalog}
                            onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, saveToCatalog: event.target.checked })}
                          />
                          Save this replacement in products
                        </label>
                        {exchangeManualItem.saveToCatalog && (
                          <label className="stock-field">
                            Opening stock
                            <input
                              min="0"
                              type="number"
                              value={exchangeManualItem.stock}
                              onChange={(event) => setExchangeManualItem({ ...exchangeManualItem, stock: event.target.value })}
                            />
                          </label>
                        )}
                        <button className="secondary-button" type="button" onClick={addManualReplacement}>
                          Add manual replacement
                        </button>
                      </div>
                      <div className="replacement-cart">
                        {replacementItems.map((item, index) => (
                          <div className="replacement-row" key={item.productId}>
                            <div><strong>{item.name}</strong><small>{item.barcode || "Manual item"}</small></div>
                            <input
                              aria-label={`${item.name} exchange quantity`}
                              min="1"
                              type="number"
                              value={item.qty}
                              onChange={(event) => updateReplacementItem(index, { qty: Number(event.target.value) })}
                            />
                            <div className="line-discount-control">
                              <select
                                aria-label={`${item.name} exchange discount type`}
                                value={item.discountMode}
                                onChange={(event) => updateReplacementItem(index, { discountMode: event.target.value })}
                              >
                                <option value="percentage">%</option>
                                <option value="fixed">₹</option>
                              </select>
                              <input
                                aria-label={`${item.name} exchange discount value`}
                                min="0"
                                max={item.discountMode === "percentage" ? "100" : undefined}
                                type="number"
                                value={item.discountValue}
                                onChange={(event) => updateReplacementItem(index, { discountValue: Number(event.target.value) })}
                              />
                            </div>
                            <strong>{money(lineTotal(item))}</strong>
                            <button className="quiet-danger" type="button" onClick={() => setReplacementItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>x</button>
                          </div>
                        ))}
                        {!replacementItems.length && <div className="empty-state">Search and add replacement products.</div>}
                      </div>
                    </section>
                  )}

                  <div className="return-footer-grid">
                    <div className="field-grid">
                      <label>
                        Reason
                        <input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="Optional reason" />
                      </label>
                      <label>
                        {returnType === "return" ? "Refund method" : "Settlement method"}
                        <select value={settlementMode} onChange={(event) => setSettlementMode(event.target.value)}>
                          <option>Cash</option>
                          <option>UPI</option>
                          <option>Store credit</option>
                          <option>Original payment</option>
                        </select>
                      </label>
                    </div>
                    <div className="return-summary">
                      <div><span>Return credit</span><strong>{money(returnCredit)}</strong></div>
                      {returnType === "exchange" && <div><span>Replacement value</span><strong>{money(replacementTotal)}</strong></div>}
                      <div className="return-settlement">
                        <span>{replacementTotal - returnCredit > 0 ? "Collect from customer" : "Refund customer"}</span>
                        <strong>{money(Math.abs(replacementTotal - returnCredit))}</strong>
                      </div>
                    </div>
                  </div>
                  <button className="primary-button" type="submit">
                    Complete {returnType}
                  </button>
                </form>
              ) : (
                <section className="panel return-empty-panel">
                  <div className="empty-state">Select an original invoice to begin a return or exchange.</div>
                </section>
              )}

              <section className="panel return-history-panel">
                <div className="panel-title">
                  <h2>Return history</h2>
                  <span>{(state.returns || []).length} records</span>
                </div>
                <div className="data-list">
                  {(state.returns || []).slice().reverse().map((record) => (
                    <article className="data-card" key={record.id}>
                      <div>
                        <strong>{record.id} · {record.type === "exchange" ? "Exchange" : "Return"}</strong>
                        <span>
                          {record.invoiceId}
                          {record.exchangeInvoiceId ? ` → ${record.exchangeInvoiceId}` : ""}
                          {" · "}
                          {record.customer.name}
                          {" · "}
                          {new Date(record.date).toLocaleString()}
                        </span>
                      </div>
                      <b>{record.difference > 0 ? `Collect ${money(record.difference)}` : `Refund ${money(Math.abs(record.difference))}`}</b>
                      <button type="button" onClick={() => printReturnSlip(record)}>Print slip</button>
                    </article>
                  ))}
                  {!(state.returns || []).length && <div className="empty-state">No returns or exchanges recorded yet.</div>}
                </div>
              </section>
            </section>
          )}

          {activeView === "settings" && (
            <section className="settings-stack">
              <form className="panel" onSubmit={saveSettings}>
                <div className="panel-title">
                  <h2>Brand and firm details</h2>
                  <button className="secondary-button" type="submit">Save settings</button>
                </div>
                <h3 className="form-section-title">Brand / store</h3>
                <div className="field-grid">
                  {["shopName", "shopPhone", "invoicePrefix"].map((field) => (
                    <label key={field}>
                      {field.replace(/([A-Z])/g, " $1")}
                      <input name={field} defaultValue={state.settings[field]} />
                    </label>
                  ))}
                  <label className="wide-field">
                    Address
                    <textarea name="shopAddress" rows="3" defaultValue={state.settings.shopAddress} />
                  </label>
                  <label className="wide-field">
                    Receipt footer
                    <input name="receiptFooter" defaultValue={state.settings.receiptFooter} />
                  </label>
                  <label>
                    UPI ID
                    <input name="upiId" defaultValue={state.settings.upiId || "Q925031435@ybl"} />
                  </label>
                </div>
                <h3 className="form-section-title">Registered firm for GST invoices</h3>
                <div className="field-grid">
                  <label>
                    Legal firm name
                    <input name="firmName" defaultValue={state.settings.firmName || ""} />
                  </label>
                  <label>
                    Firm GSTIN
                    <input name="firmGstin" defaultValue={state.settings.firmGstin || state.settings.shopGstin || ""} />
                  </label>
                  <label>
                    Firm phone
                    <input name="firmPhone" defaultValue={state.settings.firmPhone || ""} />
                  </label>
                  <label>
                    State code
                    <input name="firmStateCode" maxLength="2" defaultValue={state.settings.firmStateCode || ""} />
                  </label>
                  <label className="wide-field">
                    Registered address
                    <textarea name="firmAddress" rows="3" defaultValue={state.settings.firmAddress || ""} />
                  </label>
                </div>
              </form>
              <section className="panel">
                <div className="panel-title">
                  <h2>Data tools</h2>
                </div>
                <div className="tool-row">
                  <a className="secondary-link" href="/api/backup">Export backup</a>
                  <button className="quiet-danger" type="button" onClick={clearRecords}>Clear customers and invoices</button>
                </div>
              </section>
            </section>
          )}
        </section>
      </main>

      {manualItemOpen && (
        <div className="camera-backdrop" role="presentation">
          <form className="manual-item-dialog" onSubmit={addManualItem} role="dialog" aria-modal="true" aria-labelledby="manual-item-title">
            <div className="camera-dialog-head">
              <div>
                <p>Billing</p>
                <h2 id="manual-item-title">Add manual item</h2>
              </div>
              <button className="quiet-button" type="button" onClick={() => setManualItemOpen(false)}>
                Cancel
              </button>
            </div>
            <div className="field-grid">
              <label className="wide-field">
                Item name
                <input value={manualItem.name} onChange={(event) => setManualItem({ ...manualItem, name: event.target.value })} autoFocus required />
              </label>
              <label>
                Quantity
                <input min="1" type="number" value={manualItem.qty} onChange={(event) => setManualItem({ ...manualItem, qty: event.target.value })} />
              </label>
              <label>
                Unit price
                <input min="0" step="0.01" type="number" value={manualItem.price} onChange={(event) => setManualItem({ ...manualItem, price: event.target.value })} required />
              </label>
              <label>
                Unit cost optional
                <input min="0" step="0.01" type="number" value={manualItem.cost} onChange={(event) => setManualItem({ ...manualItem, cost: event.target.value })} placeholder="Leave blank if unknown" />
              </label>
              <label>
                Discount type
                <select value={manualItem.discountMode} onChange={(event) => setManualItem({ ...manualItem, discountMode: event.target.value })}>
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </label>
              <label>
                {manualItem.discountMode === "percentage" ? "Discount %" : "Discount amount"}
                <input
                  min="0"
                  max={manualItem.discountMode === "percentage" ? "100" : undefined}
                  step="0.01"
                  type="number"
                  value={manualItem.discountValue}
                  onChange={(event) => setManualItem({ ...manualItem, discountValue: event.target.value })}
                />
              </label>
              <label>
                Barcode
                <input value={manualItem.barcode} onChange={(event) => setManualItem({ ...manualItem, barcode: event.target.value })} />
              </label>
              <label>
                Category
                <input value={manualItem.category} onChange={(event) => setManualItem({ ...manualItem, category: event.target.value })} />
              </label>
              <label>
                HSN code
                <input value={manualItem.hsnCode} onChange={(event) => setManualItem({ ...manualItem, hsnCode: event.target.value })} />
              </label>
              <label>
                GST rate %
                <input min="0" step="0.01" type="number" value={manualItem.gstRate} onChange={(event) => setManualItem({ ...manualItem, gstRate: event.target.value })} />
              </label>
              <label className="checkbox-row wide-field">
                <input
                  type="checkbox"
                  checked={manualItem.saveToCatalog}
                  onChange={(event) => setManualItem({ ...manualItem, saveToCatalog: event.target.checked })}
                />
                <span>Save this item to the product catalog</span>
              </label>
              {manualItem.saveToCatalog && (
                <label>
                  Available stock
                  <input min="0" type="number" value={manualItem.stock} onChange={(event) => setManualItem({ ...manualItem, stock: event.target.value })} />
                </label>
              )}
            </div>
            <div className="manual-item-actions">
              <button className="quiet-button" type="button" onClick={() => setManualItemOpen(false)}>Cancel</button>
              <button className="primary-button" type="submit">
                {manualItem.saveToCatalog ? "Save product and add" : "Add to bill"}
              </button>
            </div>
          </form>
        </div>
      )}

      {cameraOpen && (
        <div className="camera-backdrop" role="presentation">
          <section className="camera-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-title">
            <div className="camera-dialog-head">
              <div>
                <p>Product image</p>
                <h2 id="camera-title">Take photo</h2>
              </div>
              <button className="quiet-button" type="button" onClick={() => setCameraOpen(false)}>
                Cancel
              </button>
            </div>
            <div className="camera-viewport">
              <video ref={cameraVideoRef} muted playsInline />
              {!cameraReady && <span>Starting camera...</span>}
            </div>
            <button className="primary-button camera-capture-button" type="button" disabled={!cameraReady} onClick={captureProductImage}>
              Capture photo
            </button>
          </section>
        </div>
      )}

      <PrintOutput invoice={lastInvoice} returnRecord={lastReturn} salesPrint={salesPrint} />
    </>
  );
}

function Totals({ totals, invoiceType, gstType }) {
  return (
    <div className="totals-list">
      <div><span>Subtotal</span><strong>{money(totals.gross)}</strong></div>
      <div>
        <span>Item discounts</span>
        <strong>{money(totals.itemDiscount)}</strong>
      </div>
      <div>
        <span>Additional bill discount{totals.discountMode === "percentage" ? ` (${totals.discountValue}%)` : ""}</span>
        <strong>{money(totals.billDiscount)}</strong>
      </div>
      {invoiceType === "gst" && (
        <>
          <div><span>Taxable value</span><strong>{money(totals.taxable)}</strong></div>
          {gstType === "intrastate" ? (
            <>
              <div><span>CGST</span><strong>{money(totals.tax / 2)}</strong></div>
              <div><span>SGST</span><strong>{money(totals.tax / 2)}</strong></div>
            </>
          ) : (
            <div><span>IGST</span><strong>{money(totals.tax)}</strong></div>
          )}
        </>
      )}
      <div className="grand-total"><span>Total</span><strong>{money(totals.total)}</strong></div>
      <div><span>Balance</span><strong>{money(totals.balance)}</strong></div>
    </div>
  );
}

function ProductImage({ product, compact = false }) {
  return (
    <span className={`product-thumb${compact ? " compact" : ""}`} aria-hidden="true">
      {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span>{product.name?.charAt(0)?.toUpperCase() || "A"}</span>}
    </span>
  );
}

function ReceiptBarcode({ value }) {
  const barcodeSvgRef = useRef(null);

  useEffect(() => {
    if (!barcodeSvgRef.current || !value) return;
    try {
      JsBarcode(barcodeSvgRef.current, String(value), {
        format: "CODE128",
        width: 1.1,
        height: 24,
        displayValue: true,
        fontSize: 8,
        textMargin: 2,
        margin: 0,
        background: "#ffffff",
        lineColor: "#000000",
      });
    } catch {
      barcodeSvgRef.current.replaceChildren();
    }
  }, [value]);

  return <svg className="receipt-barcode" ref={barcodeSvgRef} aria-label={`Barcode ${value}`} />;
}

function UpiPaymentQr({ invoice }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const upiId = invoice.shop.upiId || "Q925031435@ybl";
  const amount = Number(invoice.totals.total || 0).toFixed(2);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      pa: upiId,
      pn: invoice.shop.shopName || "Alter",
      am: amount,
      cu: "INR",
      tn: `Invoice ${invoice.id}`,
    });
    QRCode.toDataURL(`upi://pay?${params.toString()}`, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (!cancelled) setQrDataUrl("");
    });
    return () => {
      cancelled = true;
    };
  }, [amount, invoice.id, invoice.shop.shopName, upiId]);

  return (
    <div className="upi-payment">
      <strong>Scan to pay {receiptMoney(invoice.totals.total)}</strong>
      {qrDataUrl && <img src={qrDataUrl} alt={`UPI QR for ${receiptMoney(invoice.totals.total)}`} />}
      <span>{upiId}</span>
    </div>
  );
}

function ListPanel({ title, search, setSearch, placeholder, children }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={placeholder} />
      </div>
      <div className="data-list">{children}</div>
    </section>
  );
}

function PrintOutput({ invoice, returnRecord, salesPrint }) {
  if (salesPrint) return <DaySalesReceipt report={salesPrint} />;
  if (returnRecord) return <ReturnSlip record={returnRecord} />;
  if (!invoice) return <section className="print-output" aria-hidden="true" />;
  if (invoice.invoiceType === "gst") return <GstInvoice invoice={invoice} />;
  return <Receipt invoice={invoice} />;
}

function DaySalesReceipt({ report }) {
  const shop = report.shop || {};
  const printedAt = new Date();

  return (
    <section className="print-output thermal-print" aria-hidden="true">
      <div className="receipt day-sales-receipt">
        <img className="receipt-logo" src="/alter-logo-cropped.png" alt="Alter" />
        <h1>{shop.shopName || "Alter"}</h1>
        {shop.shopAddress && <p>{shop.shopAddress}</p>}
        {shop.shopPhone && <p>Phone: {shop.shopPhone}</p>}
        <div className="receipt-rule" />
        <h2 className="return-slip-title">DAILY SALES</h2>
        <div className="receipt-line"><span>Date</span><strong>{new Date(`${report.date}T00:00:00`).toLocaleDateString()}</strong></div>
        <div className="receipt-line"><span>Printed</span><strong>{printedAt.toLocaleString()}</strong></div>
        <div className="receipt-rule" />
        <div className="receipt-line"><span>Bills</span><strong>{report.summary.count}</strong></div>
        <div className="receipt-line"><span>Gross</span><strong>{receiptMoney(report.summary.gross)}</strong></div>
        <div className="receipt-line"><span>Discount</span><strong>{receiptMoney(report.summary.discount)}</strong></div>
        <div className="receipt-line"><span>Tax</span><strong>{receiptMoney(report.summary.tax)}</strong></div>
        <div className="receipt-total"><span>Net sales</span><strong>{receiptMoney(report.summary.total)}</strong></div>
        <div className="receipt-rule" />
        <strong>Payment summary</strong>
        <div className="receipt-line"><span>Cash</span><strong>{receiptMoney(report.summary.cash)}</strong></div>
        <div className="receipt-line"><span>UPI</span><strong>{receiptMoney(report.summary.upi)}</strong></div>
        <div className="receipt-line"><span>Card</span><strong>{receiptMoney(report.summary.card)}</strong></div>
        <div className="receipt-line"><span>Mixed</span><strong>{receiptMoney(report.summary.mixed)}</strong></div>
        <div className="receipt-rule" />
        <strong>Bill details</strong>
        <table className="daily-sales-table">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Mode</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {report.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <strong>{invoice.id}</strong>
                  <span>{new Date(invoice.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </td>
                <td>{invoice.paymentMode}</td>
                <td>{formattedAmount(invoice.totals.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="receipt-footer">{shop.receiptFooter}</p>
        <div className="receipt-end-line" aria-hidden="true" />
      </div>
    </section>
  );
}

function ReturnSlip({ record }) {
  const shop = record.shop || {};
  const isExchange = record.type === "exchange";
  const difference = Number(record.difference || 0);

  return (
    <section className="print-output thermal-print" aria-hidden="true">
      <div className="receipt return-slip">
        <img className="receipt-logo" src="/alter-logo-cropped.png" alt="Alter" />
        <h1>{shop.shopName || "Alter"}</h1>
        {shop.shopAddress && <p>{shop.shopAddress}</p>}
        {shop.shopPhone && <p>Phone: {shop.shopPhone}</p>}
        <div className="receipt-rule" />
        <h2 className="return-slip-title">{isExchange ? "EXCHANGE SLIP" : "RETURN SLIP"}</h2>
        <div className="receipt-line"><span>Return ID</span><strong>{record.id}</strong></div>
        <div className="receipt-line"><span>Original bill</span><strong>{record.invoiceId}</strong></div>
        {isExchange && record.exchangeInvoiceId && (
          <div className="receipt-line"><span>Exchange bill</span><strong>{record.exchangeInvoiceId}</strong></div>
        )}
        <div className="receipt-line"><span>Date</span><strong>{new Date(record.date).toLocaleString()}</strong></div>
        <div className="receipt-line"><span>Customer</span><strong>{record.customer?.name || "Walk-in customer"}</strong></div>
        <div className="receipt-invoice-barcode">
          <ReceiptBarcode value={record.id} />
        </div>
        <div className="receipt-rule" />
        <strong>Returned items</strong>
        <table className="return-slip-table">
          <thead>
            <tr><th>Item</th><th>Qty</th><th>Credit</th></tr>
          </thead>
          <tbody>
            {record.items.map((item, index) => (
              <tr key={`${item.itemIndex}-${index}`}>
                <td>{item.name}</td>
                <td>{item.qty}</td>
                <td>{formattedAmount(item.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isExchange && (
          <>
            <div className="receipt-rule" />
            <strong>Replacement items</strong>
            <table className="return-slip-table">
              <thead>
                <tr><th>Item</th><th>Qty</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {record.replacements.map((item, index) => (
                  <tr key={`${item.productId}-${index}`}>
                    <td>{item.name}</td>
                    <td>{item.qty}</td>
                    <td>{formattedAmount(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="receipt-rule" />
        <div className="receipt-line"><span>Return credit</span><strong>{receiptMoney(record.creditTotal)}</strong></div>
        {isExchange && <div className="receipt-line"><span>Replacement value</span><strong>{receiptMoney(record.replacementTotal)}</strong></div>}
        <div className="receipt-total">
          <span>{difference > 0 ? "Amount collected" : "Refund"}</span>
          <strong>{receiptMoney(Math.abs(difference))}</strong>
        </div>
        <div className="receipt-line"><span>Settlement</span><strong>{record.settlementMode}</strong></div>
        {record.reason && <p className="return-slip-reason"><strong>Reason:</strong> {record.reason}</p>}
        <p className="receipt-footer">{shop.receiptFooter}</p>
        <div className="receipt-end-line" aria-hidden="true" />
      </div>
    </section>
  );
}

function Receipt({ invoice }) {
  return (
    <section className="print-output thermal-print" aria-hidden="true">
      <div className="receipt">
        <img className="receipt-logo" src="/alter-logo-cropped.png" alt="Alter" />
        <h1>{invoice.shop.shopName}</h1>
        {invoice.shop.shopAddress && <p>{invoice.shop.shopAddress}</p>}
        {invoice.shop.shopPhone && <p>Phone: {invoice.shop.shopPhone}</p>}
        <div className="receipt-rule" />
        <div className="receipt-line"><span>Bill</span><strong>{invoice.id}</strong></div>
        <div className="receipt-line"><span>Date</span><strong>{new Date(invoice.date).toLocaleString()}</strong></div>
        <div className="receipt-invoice-barcode">
          <ReceiptBarcode value={invoice.id} />
        </div>
        <div className="receipt-line"><span>Customer</span><strong>{invoice.customer.name}</strong></div>
        {invoice.customer.phone && <div className="receipt-line"><span>Phone</span><strong>{invoice.customer.phone}</strong></div>}
        <div className="receipt-rule" />
        <table className="receipt-items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>MRP</th>
              <th>Disc.</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => (
              <tr key={`${item.barcode}-${index}`}>
                <td>{item.name} x {item.qty}</td>
                <td>{formattedAmount(item.price)}</td>
                <td>{formattedAmount(lineDiscount(item))}</td>
                <td>{formattedAmount(lineTotal(item))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="receipt-rule" />
        <div className="receipt-line"><span>Subtotal</span><strong>{receiptMoney(invoice.totals.gross)}</strong></div>
        <div className="receipt-line"><span>Discount</span><strong>{receiptMoney(invoice.totals.discount)}</strong></div>
        <div className="receipt-line"><span>Tax</span><strong>{receiptMoney(invoice.totals.tax)}</strong></div>
        <div className="receipt-total"><span>Total</span><strong>{receiptMoney(invoice.totals.total)}</strong></div>
        <p className="receipt-footer">{invoice.shop.receiptFooter}</p>
        <UpiPaymentQr invoice={invoice} />
        <div className="receipt-end-line" aria-hidden="true" />
      </div>
    </section>
  );
}

function GstInvoice({ invoice }) {
  const isInterstate = invoice.gstType === "interstate";
  const firmName = invoice.shop.firmName || invoice.shop.shopName;
  const firmAddress = invoice.shop.firmAddress || invoice.shop.shopAddress;
  const firmPhone = invoice.shop.firmPhone || invoice.shop.shopPhone;
  const firmGstin = invoice.shop.firmGstin || invoice.shop.shopGstin;

  const hsnSummary = Object.values(
    invoice.items.reduce((summary, item) => {
      const key = `${item.hsnCode || "NA"}-${item.gstRate || 0}`;
      if (!summary[key]) {
        summary[key] = { hsnCode: item.hsnCode || "NA", gstRate: Number(item.gstRate || 0), taxable: 0, tax: 0 };
      }
      summary[key].taxable += Number(item.taxable || 0);
      summary[key].tax += Number(item.gstAmount || 0);
      return summary;
    }, {})
  );

  return (
    <section className="print-output gst-print" aria-hidden="true">
      <article className="gst-invoice">
        <header className="gst-header">
          <img src="/alter-logo-cropped.png" alt="Alter" />
          <div>
            <h1>{firmName}</h1>
            <p>{firmAddress}</p>
            <p>{firmPhone && `Phone: ${firmPhone}`}</p>
            <p><strong>GSTIN: {firmGstin || "Not configured"}</strong></p>
          </div>
          <div className="gst-title">
            <strong>TAX INVOICE</strong>
            <span>Original for recipient</span>
          </div>
        </header>

        <section className="gst-meta-grid">
          <div>
            <h2>Bill to</h2>
            <strong>{invoice.customer.name}</strong>
            <p>{invoice.customer.address || "Address not provided"}</p>
            <p>{invoice.customer.phone && `Phone: ${invoice.customer.phone}`}</p>
            <p>GSTIN: {invoice.customer.gstin || "Unregistered"}</p>
            <p>State code: {invoice.customer.stateCode || "-"}</p>
          </div>
          <div>
            <p><span>Invoice No.</span><strong>{invoice.id}</strong></p>
            <p><span>Invoice Date</span><strong>{new Date(invoice.date).toLocaleDateString("en-IN")}</strong></p>
            <p><span>Supply type</span><strong>{isInterstate ? "Interstate" : "Intrastate"}</strong></p>
            <p><span>Place of supply</span><strong>State {invoice.customer.stateCode || invoice.shop.firmStateCode || "-"}</strong></p>
            <p><span>Payment</span><strong>{invoice.paymentMode}</strong></p>
          </div>
        </section>

        <table className="gst-items-table">
          <thead>
            <tr>
              <th>No.</th>
              <th>Description</th>
              <th>HSN</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Discount</th>
              <th>Taxable</th>
              <th>GST %</th>
              {!isInterstate && <th>CGST</th>}
              {!isInterstate && <th>SGST</th>}
              {isInterstate && <th>IGST</th>}
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, index) => (
              <tr key={`${item.barcode}-${index}`}>
                <td>{index + 1}</td>
                <td>{item.name}</td>
                <td>{item.hsnCode || "-"}</td>
                <td>{item.qty}</td>
                <td>{money(item.price)}</td>
                <td>{money(item.discount)}</td>
                <td>{money(item.taxable)}</td>
                <td>{item.gstRate || 0}%</td>
                {!isInterstate && <td>{money(Number(item.gstAmount || 0) / 2)}</td>}
                {!isInterstate && <td>{money(Number(item.gstAmount || 0) / 2)}</td>}
                {isInterstate && <td>{money(item.gstAmount)}</td>}
                <td>{money(Number(item.taxable || 0) + Number(item.gstAmount || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="gst-bottom-grid">
          <div>
            <h2>HSN summary</h2>
            <table className="hsn-table">
              <thead>
                <tr>
                  <th>HSN</th>
                  <th>Taxable</th>
                  <th>Rate</th>
                  <th>Tax</th>
                </tr>
              </thead>
              <tbody>
                {hsnSummary.map((row) => (
                  <tr key={`${row.hsnCode}-${row.gstRate}`}>
                    <td>{row.hsnCode}</td>
                    <td>{money(row.taxable)}</td>
                    <td>{row.gstRate}%</td>
                    <td>{money(row.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="gst-totals">
            <p><span>Gross value</span><strong>{money(invoice.totals.gross)}</strong></p>
            <p><span>Discount</span><strong>{money(invoice.totals.discount)}</strong></p>
            <p><span>Taxable value</span><strong>{money(invoice.totals.taxable)}</strong></p>
            {!isInterstate && <p><span>CGST</span><strong>{money(invoice.totals.tax / 2)}</strong></p>}
            {!isInterstate && <p><span>SGST</span><strong>{money(invoice.totals.tax / 2)}</strong></p>}
            {isInterstate && <p><span>IGST</span><strong>{money(invoice.totals.tax)}</strong></p>}
            <p className="gst-grand-total"><span>Invoice total</span><strong>{money(invoice.totals.total)}</strong></p>
          </div>
        </section>

        <footer className="gst-footer">
          <div>
            <strong>Declaration</strong>
            <p>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</p>
          </div>
          <div>
            <strong>For {firmName}</strong>
            <span>Authorised signatory</span>
          </div>
        </footer>
      </article>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
