import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
try {
  loadEnvFile(path.join(rootDir, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");
const productImagesDir = path.join(dataDir, "product-images");
const port = Number(process.env.PORT || 4173);
const mongoUri = process.env.MONGODB_URI;
const mongoDatabaseName = process.env.MONGODB_DB || "alter-billing";
const whatsappAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const whatsappApiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";
const whatsappWebhookVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "taara_whatsapp_verify_2026";
const whatsappTemplateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
const whatsappInvoiceTemplate = process.env.WHATSAPP_INVOICE_TEMPLATE || "invoice_sent";
const whatsappPromotionTemplate = process.env.WHATSAPP_PROMOTION_TEMPLATE || "alter_new_arrivals";
const whatsappGenericTemplate = process.env.WHATSAPP_GENERIC_TEMPLATE || "taara_generic_message";
let mongoClientPromise;

const defaultDb = {
  settings: {
    shopName: "Alter",
    shopPhone: "",
    shopAddress: "",
    shopGstin: "",
    firmName: "",
    firmPhone: "",
    firmAddress: "",
    firmGstin: "",
    firmStateCode: "",
    upiId: "Q925031435@ybl",
    invoicePrefix: "ALT",
    receiptFooter: "Thank you for shopping with Alter",
  },
  products: [],
  customers: [],
  invoices: [],
  returns: [],
  whatsappMessages: [],
  whatsappWebhookLogs: [],
};

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use("/product-images", express.static(productImagesDir));

async function readDb() {
  if (mongoUri) return readMongoDb();
  return readJsonDb();
}

async function writeDb(db) {
  if (mongoUri) {
    await writeMongoDb(db);
    return;
  }
  await writeJsonDb(db);
}

async function readJsonDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeJsonDb(defaultDb);
    return structuredClone(defaultDb);
  }
}

async function writeJsonDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

function normalizeDb(db = {}) {
  return {
    ...defaultDb,
    ...db,
    settings: { ...defaultDb.settings, ...(db.settings || {}) },
    products: Array.isArray(db.products) ? db.products : [],
    customers: Array.isArray(db.customers) ? db.customers : [],
    invoices: Array.isArray(db.invoices) ? db.invoices : [],
    returns: Array.isArray(db.returns) ? db.returns : [],
    whatsappMessages: Array.isArray(db.whatsappMessages) ? db.whatsappMessages : [],
    whatsappWebhookLogs: Array.isArray(db.whatsappWebhookLogs) ? db.whatsappWebhookLogs : [],
  };
}

async function getMongoDb() {
  if (!mongoClientPromise) {
    const client = new MongoClient(mongoUri);
    mongoClientPromise = client.connect().then(() => client);
  }
  return (await mongoClientPromise).db(mongoDatabaseName);
}

async function readMongoDb() {
  const db = await getMongoDb();
  const [settings, products, customers, invoices, returns, whatsappMessages, whatsappWebhookLogs] = await Promise.all([
    db.collection("settings").findOne({ id: "settings" }, { projection: { _id: 0 } }),
    db.collection("products").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("customers").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("invoices").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("returns").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("whatsappMessages").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("whatsappWebhookLogs").find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(50).toArray(),
  ]);

  return normalizeDb({ settings, products, customers, invoices, returns, whatsappMessages, whatsappWebhookLogs });
}

async function writeMongoDb(appDb) {
  const db = await getMongoDb();
  const normalized = normalizeDb(appDb);
  await Promise.all([
    replaceMongoCollection(db, "products", normalized.products),
    replaceMongoCollection(db, "customers", normalized.customers),
    replaceMongoCollection(db, "invoices", normalized.invoices),
    replaceMongoCollection(db, "returns", normalized.returns),
    replaceMongoCollection(db, "whatsappMessages", normalized.whatsappMessages),
    replaceMongoCollection(db, "whatsappWebhookLogs", normalized.whatsappWebhookLogs),
    db.collection("settings").replaceOne(
      { id: "settings" },
      { id: "settings", ...normalized.settings },
      { upsert: true }
    ),
  ]);
}

async function replaceMongoCollection(db, collectionName, records) {
  const collection = db.collection(collectionName);
  await collection.deleteMany({});
  if (records.length) await collection.insertMany(records);
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function invoiceId(db) {
  const prefix = db.settings.invoicePrefix || "ALT";
  if (mongoUri) {
    const sequence = await nextMongoSequence(`invoice:${prefix}`, "invoices", prefix);
    return `${prefix}-${String(sequence).padStart(5, "0")}`;
  }
  return `${prefix}-${String(db.invoices.length + 1).padStart(5, "0")}`;
}

async function returnId(db) {
  if (mongoUri) {
    const sequence = await nextMongoSequence("return:RET", "returns", "RET");
    return `RET-${String(sequence).padStart(5, "0")}`;
  }
  return `RET-${String(db.returns.length + 1).padStart(5, "0")}`;
}

async function nextMongoSequence(counterId, collectionName, prefix) {
  const db = await getMongoDb();
  const counters = db.collection("counters");
  const existingCounter = await counters.findOne({ _id: counterId });
  if (!existingCounter) {
    const seed = await maxExistingSequence(db, collectionName, prefix);
    await counters.updateOne({ _id: counterId }, { $setOnInsert: { seq: seed } }, { upsert: true });
  }
  const updated = await counters.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  );
  const counter = updated?.value || updated;
  return Number(counter?.seq || 1);
}

async function maxExistingSequence(db, collectionName, prefix) {
  const prefixText = `${prefix}-`;
  const records = await db.collection(collectionName).find({}, { projection: { id: 1 } }).toArray();
  return records.reduce((max, record) => {
    if (!String(record.id || "").startsWith(prefixText)) return max;
    const sequence = Number(String(record.id).slice(prefixText.length));
    return Number.isFinite(sequence) ? Math.max(max, sequence) : max;
  }, 0);
}

function invoiceLineCredit(invoice, item) {
  const taxable = Number(item.taxable || 0);
  const gstAmount = Number(item.gstAmount || 0);
  if (invoice.invoiceType === "gst") return Math.max(0, taxable + gstAmount);
  if (taxable > 0) return taxable;
  return Math.max(0, Number(item.qty || 0) * Number(item.price || 0) - Number(item.discount || 0));
}

function buildInvoice(db, body, { id, date } = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    id,
    date: date || new Date().toISOString(),
    customer: {
      name: String(body.customer.name || "").trim(),
      phone: String(body.customer.phone || "").trim(),
      address: String(body.customer.address || "").trim(),
      gstin: String(body.customer.gstin || "").trim(),
      stateCode: String(body.customer.stateCode || "").trim(),
      whatsappOptIn: Boolean(body.customer.whatsappOptIn),
      whatsappOptInAt: body.customer.whatsappOptIn ? String(body.customer.whatsappOptInAt || new Date().toISOString()) : "",
    },
    items: items.map((item) => ({
      productId: item.productId || "",
      name: String(item.name || "").trim(),
      barcode: String(item.barcode || "").trim(),
      hsnCode: String(item.hsnCode || "").trim(),
      gstRate: Math.max(0, Number(item.gstRate) || 0),
      qty: Math.max(1, Number(item.qty) || 1),
      price: Math.max(0, Number(item.price) || 0),
      cost: Math.max(0, Number(item.cost) || 0),
      discount: Math.max(0, Number(item.discount) || 0),
      discountMode: item.discountMode === "percentage" ? "percentage" : "fixed",
      discountValue: Math.max(0, Number(item.discountValue) || 0),
      taxable: Math.max(0, Number(item.taxable) || 0),
      gstAmount: Math.max(0, Number(item.gstAmount) || 0),
    })),
    totals: body.totals,
    invoiceType: body.invoiceType === "gst" ? "gst" : "regular",
    gstType: body.gstType === "interstate" ? "interstate" : "intrastate",
    paymentMode: String(body.paymentMode || "Cash"),
    shop: { ...db.settings },
  };
}

function validateInvoiceInput(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!body.customer?.name?.trim() || !items.length) return "Customer name and at least one item are required.";
  return "";
}

function buildExchangeInvoice(db, sourceInvoice, replacements, exchangeRecord) {
  const items = replacements.map((item) => {
    const discount = Math.max(0, Number(item.discount) || 0);
    const taxable = Math.max(0, Number(item.amount || 0));
    const gstRate = Math.max(0, Number(item.gstRate) || 0);
    return {
      productId: item.productId || "",
      name: String(item.name || "").trim(),
      barcode: String(item.barcode || "").trim(),
      hsnCode: String(item.hsnCode || "").trim(),
      gstRate,
      qty: Math.max(1, Number(item.qty) || 1),
      price: Math.max(0, Number(item.price) || 0),
      cost: Math.max(0, Number(item.cost) || 0),
      discount,
      discountMode: item.discountMode === "fixed" ? "fixed" : "percentage",
      discountValue: Math.max(0, Number(item.discountValue) || 0),
      taxable,
      gstAmount: sourceInvoice.invoiceType === "gst" ? taxable * (gstRate / 100) : 0,
    };
  });
  const gross = items.reduce((sum, item) => sum + Number(item.qty || 0) * Number(item.price || 0), 0);
  const itemDiscount = items.reduce((sum, item) => sum + Number(item.discount || 0), 0);
  const taxable = items.reduce((sum, item) => sum + Number(item.taxable || 0), 0);
  const tax = items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0);
  const total = taxable + tax;
  return {
    id: exchangeRecord.exchangeInvoiceId,
    date: exchangeRecord.date,
    customer: { ...sourceInvoice.customer },
    items,
    totals: {
      gross,
      itemDiscount,
      billDiscount: 0,
      discount: itemDiscount,
      discountMode: "fixed",
      discountValue: 0,
      taxable,
      tax,
      total,
      paid: Math.max(0, Number(exchangeRecord.difference || 0)),
      balance: 0,
      exchangeCredit: Number(exchangeRecord.creditTotal || 0),
      exchangeDifference: Number(exchangeRecord.difference || 0),
    },
    invoiceType: sourceInvoice.invoiceType === "gst" ? "gst" : "regular",
    gstType: sourceInvoice.gstType === "interstate" ? "interstate" : "intrastate",
    paymentMode: exchangeRecord.settlementMode,
    shop: { ...db.settings },
    source: "exchange",
    exchangeId: exchangeRecord.id,
    originalInvoiceId: sourceInvoice.id,
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, headers) {
  return [
    headers.map((header) => csvEscape(header.label)).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(header.value(row))).join(",")),
  ].join("\n");
}

function normalizeProduct(input, existing = {}) {
  return {
    id: input.id || makeId("prd"),
    name: String(input.name || "").trim(),
    barcode: String(input.barcode || "").trim(),
    sku: String(input.sku || "").trim(),
    category: String(input.category || "").trim(),
    hsnCode: String(input.hsnCode || "").trim(),
    gstRate: Math.max(0, Number(input.gstRate) || 0),
    price: Math.max(0, Number(input.price) || 0),
    cost: Math.max(0, Number(input.cost) || 0),
    stock: Math.max(0, Number(input.stock) || 0),
    imageUrl: existing.imageUrl || "",
  };
}

async function deleteProductImage(imageUrl) {
  if (!imageUrl?.startsWith("/product-images/")) return;
  const filename = path.basename(imageUrl);
  await fs.unlink(path.join(productImagesDir, filename)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function saveProductImage(productId, imageData, oldImageUrl) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(imageData || "");
  if (!match) throw new Error("Product image must be a PNG, JPEG, or WebP file.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    throw new Error("Product image must be smaller than 5 MB.");
  }
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  await fs.mkdir(productImagesDir, { recursive: true });
  await deleteProductImage(oldImageUrl);
  const filename = `${productId}-${Date.now()}.${extension}`;
  await fs.writeFile(path.join(productImagesDir, filename), buffer);
  return `/product-images/${filename}`;
}

function upsertCustomer(db, invoice) {
  const phone = invoice.customer.phone.trim();
  const key = phone || invoice.customer.name.trim().toLowerCase();
  const existing = db.customers.find((customer) => customer.key === key);
  if (existing) {
    existing.name = invoice.customer.name;
    existing.phone = invoice.customer.phone;
    existing.address = invoice.customer.address;
    existing.gstin = invoice.customer.gstin;
    existing.stateCode = invoice.customer.stateCode;
    existing.whatsappOptIn = Boolean(existing.whatsappOptIn || invoice.customer.whatsappOptIn);
    existing.whatsappOptInAt = invoice.customer.whatsappOptInAt || existing.whatsappOptInAt || "";
    existing.invoiceCount += 1;
    existing.totalSpent += invoice.totals.total;
    existing.lastPurchase = invoice.date;
    existing.source = existing.source || "invoice";
    return;
  }
  db.customers.push({
    key,
    name: invoice.customer.name,
    phone: invoice.customer.phone,
    address: invoice.customer.address,
    gstin: invoice.customer.gstin,
    stateCode: invoice.customer.stateCode,
    whatsappOptIn: Boolean(invoice.customer.whatsappOptIn),
    whatsappOptInAt: invoice.customer.whatsappOptInAt || "",
    invoiceCount: 1,
    totalSpent: invoice.totals.total,
    lastPurchase: invoice.date,
    source: "invoice",
  });
}

function customerKey(customer) {
  const phone = String(customer?.phone || "").trim();
  return phone || String(customer?.name || "").trim().toLowerCase();
}

function summarizeCustomers(invoices, existingCustomers = []) {
  const customers = new Map();
  for (const customer of existingCustomers) {
    if (customer.source !== "manual") continue;
    const key = customerKey(customer);
    if (!key) continue;
    customers.set(key, {
      key,
      name: customer.name || "",
      phone: customer.phone || "",
      address: customer.address || "",
      gstin: customer.gstin || "",
      stateCode: customer.stateCode || "",
      whatsappOptIn: Boolean(customer.whatsappOptIn),
      whatsappOptInAt: customer.whatsappOptInAt || "",
      invoiceCount: 0,
      totalSpent: 0,
      lastPurchase: "",
      source: "manual",
    });
  }
  for (const invoice of invoices) {
    const key = customerKey(invoice.customer);
    if (!key) continue;
    const existing = customers.get(key);
    if (existing) {
      existing.name = invoice.customer.name;
      existing.phone = invoice.customer.phone;
      existing.address = invoice.customer.address;
      existing.gstin = invoice.customer.gstin;
      existing.stateCode = invoice.customer.stateCode;
      existing.whatsappOptIn = Boolean(existing.whatsappOptIn || invoice.customer.whatsappOptIn);
      existing.whatsappOptInAt = invoice.customer.whatsappOptInAt || existing.whatsappOptInAt || "";
      existing.invoiceCount += 1;
      existing.totalSpent += Number(invoice.totals.total || 0);
      if (invoice.date > existing.lastPurchase) existing.lastPurchase = invoice.date;
    } else {
      customers.set(key, {
        key,
        name: invoice.customer.name,
        phone: invoice.customer.phone,
        address: invoice.customer.address,
        gstin: invoice.customer.gstin,
        stateCode: invoice.customer.stateCode,
        whatsappOptIn: Boolean(invoice.customer.whatsappOptIn),
        whatsappOptInAt: invoice.customer.whatsappOptInAt || "",
        invoiceCount: 1,
        totalSpent: Number(invoice.totals.total || 0),
        lastPurchase: invoice.date,
        source: "invoice",
      });
    }
  }
  return [...customers.values()];
}

function rebuildCustomers(db) {
  db.customers = summarizeCustomers(db.invoices, db.customers);
}

async function upsertCustomerInMongo(invoice) {
  const db = await getMongoDb();
  const phone = invoice.customer.phone.trim();
  const key = phone || invoice.customer.name.trim().toLowerCase();
  const existing = await db.collection("customers").findOne({ key }, { projection: { whatsappOptIn: 1, whatsappOptInAt: 1 } });
  await db.collection("customers").updateOne(
    { key },
    {
      $set: {
        name: invoice.customer.name,
        phone: invoice.customer.phone,
        address: invoice.customer.address,
        gstin: invoice.customer.gstin,
        stateCode: invoice.customer.stateCode,
        whatsappOptIn: Boolean(existing?.whatsappOptIn || invoice.customer.whatsappOptIn),
        whatsappOptInAt: invoice.customer.whatsappOptInAt || existing?.whatsappOptInAt || "",
        lastPurchase: invoice.date,
        source: existing?.source || "invoice",
      },
      $setOnInsert: { key },
      $inc: {
        invoiceCount: 1,
        totalSpent: Number(invoice.totals.total || 0),
      },
    },
    { upsert: true }
  );
}

async function replaceMongoCustomers(invoices, existingCustomers = []) {
  const db = await getMongoDb();
  await replaceMongoCollection(db, "customers", summarizeCustomers(invoices, existingCustomers));
}

function invoiceStockChanges(invoice, direction) {
  return invoice.items.map((line) => ({
    productId: line.productId,
    barcode: line.barcode,
    qty: direction * Number(line.qty || 0),
  }));
}

function adjustLocalStock(products, changes) {
  for (const change of changes) {
    if (!change.qty) continue;
    const product = products.find((candidate) =>
      change.productId ? candidate.id === change.productId : candidate.barcode === change.barcode
    );
    if (product) product.stock = Math.max(0, Number(product.stock || 0) + change.qty);
  }
}

async function adjustMongoStock(changes) {
  const updates = changes
    .filter((change) => change.qty && (change.productId || change.barcode))
    .map((change) => ({
      updateOne: {
        filter: change.productId ? { id: change.productId } : { barcode: change.barcode },
        update: [
          {
            $set: {
              stock: { $max: [0, { $add: [{ $ifNull: ["$stock", 0] }, change.qty] }] },
            },
          },
        ],
      },
    }));
  if (!updates.length) return;
  const db = await getMongoDb();
  await db.collection("products").bulkWrite(updates);
}

function normalizeWhatsAppPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function customerForWhatsAppPhone(db, phone) {
  const normalized = normalizeWhatsAppPhone(phone);
  return db.customers.find((customer) => normalizeWhatsAppPhone(customer.phone) === normalized) || null;
}

function whatsappMessageText(message) {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.image) return message.image.caption || "[Image]";
  if (message.document) return message.document.caption || message.document.filename || "[Document]";
  if (message.audio) return "[Audio]";
  if (message.video) return message.video.caption || "[Video]";
  if (message.sticker) return "[Sticker]";
  return `[${message.type || "message"}]`;
}

function parseWhatsAppWebhookEvents(db, body) {
  const events = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      for (const message of value.messages || []) {
        const customer = customerForWhatsAppPhone(db, message.from);
        events.push({
          id: message.id || makeId("wam"),
          direction: "incoming",
          from: normalizeWhatsAppPhone(message.from),
          to: value.metadata?.display_phone_number || "",
          customerKey: customer?.key || "",
          customerName: customer?.name || value.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name || "",
          type: message.type || "unknown",
          text: whatsappMessageText(message),
          mediaId: message.image?.id || message.document?.id || message.audio?.id || message.video?.id || "",
          timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
          raw: message,
        });
      }
      for (const status of value.statuses || []) {
        const statusError = status.errors?.[0];
        const statusText = statusError
          ? `${status.status || "status"}: ${statusError.title || statusError.message || statusError.code || "WhatsApp delivery error"}`
          : status.status || "status";
        events.push({
          id: status.id || makeId("was"),
          direction: "status",
          from: "",
          to: normalizeWhatsAppPhone(status.recipient_id),
          customerKey: customerForWhatsAppPhone(db, status.recipient_id)?.key || "",
          customerName: customerForWhatsAppPhone(db, status.recipient_id)?.name || "",
          type: "status",
          text: statusText,
          status: status.status || "",
          timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(),
          raw: status,
        });
      }
    }
  }
  return events;
}

function whatsappStoredEventKey(event) {
  return [event.direction || "", event.id || "", event.status || "", event.type || ""].join(":");
}

function whatsappConfigured() {
  return Boolean(whatsappAccessToken && whatsappPhoneNumberId);
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number(value || 0) % 1 ? 2 : 0,
  });
}

function invoiceWhatsAppText(invoice) {
  const shop = invoice.shop || {};
  const lines = [
    `Thank you for shopping with ${shop.shopName || "Alter"}.`,
    `Bill: ${invoice.id}`,
    `Date: ${new Date(invoice.date).toLocaleString("en-IN")}`,
    `Total: ₹${formatCurrency(invoice.totals?.total)}`,
    `Payment: ${invoice.paymentMode || "Cash"}`,
  ];
  if (shop.shopPhone) lines.push(`Store: ${shop.shopPhone}`);
  lines.push("Please keep this message for your records.");
  return lines.join("\n");
}

async function sendWhatsAppText({ to, text }) {
  if (!whatsappConfigured()) {
    const error = new Error("WhatsApp is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    error.status = 400;
    throw error;
  }
  const normalizedPhone = normalizeWhatsAppPhone(to);
  if (!normalizedPhone) {
    const error = new Error("A valid WhatsApp phone number is required.");
    error.status = 400;
    throw error;
  }
  const response = await fetch(`https://graph.facebook.com/${whatsappApiVersion}/${whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "text",
      text: {
        preview_url: false,
        body: text,
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "WhatsApp message failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function parseCampaignImage(imageData) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(imageData || "");
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    const error = new Error("Campaign image must be smaller than 5 MB.");
    error.status = 400;
    throw error;
  }
  return {
    buffer,
    mimeType: `image/${match[1]}`,
    filename: `alter-campaign.${match[1] === "jpeg" ? "jpg" : match[1]}`,
  };
}

async function uploadWhatsAppImage(imageData) {
  if (!whatsappConfigured()) {
    const error = new Error("WhatsApp is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    error.status = 400;
    throw error;
  }
  const image = parseCampaignImage(imageData);
  if (!image) return "";
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", image.mimeType);
  form.append("file", new Blob([image.buffer], { type: image.mimeType }), image.filename);
  const response = await fetch(`https://graph.facebook.com/${whatsappApiVersion}/${whatsappPhoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${whatsappAccessToken}` },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "WhatsApp image upload failed.");
    error.status = response.status;
    throw error;
  }
  return payload.id || "";
}

async function sendWhatsAppImage({ to, mediaId, caption }) {
  if (!whatsappConfigured()) {
    const error = new Error("WhatsApp is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    error.status = 400;
    throw error;
  }
  const normalizedPhone = normalizeWhatsAppPhone(to);
  if (!normalizedPhone) {
    const error = new Error("A valid WhatsApp phone number is required.");
    error.status = 400;
    throw error;
  }
  const response = await fetch(`https://graph.facebook.com/${whatsappApiVersion}/${whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "image",
      image: {
        id: mediaId,
        caption,
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "WhatsApp image message failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function templateTextParameter(value) {
  return {
    type: "text",
    text: String(value ?? ""),
  };
}

function templateBodyComponent(values) {
  return {
    type: "body",
    parameters: values.map(templateTextParameter),
  };
}

function templateImageHeaderComponent(mediaId) {
  return {
    type: "header",
    parameters: [
      {
        type: "image",
        image: { id: mediaId },
      },
    ],
  };
}

async function sendWhatsAppTemplate({ to, templateName, languageCode = whatsappTemplateLanguage, bodyValues = [], imageMediaId = "" }) {
  if (!whatsappConfigured()) {
    const error = new Error("WhatsApp is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
    error.status = 400;
    throw error;
  }
  const normalizedPhone = normalizeWhatsAppPhone(to);
  if (!normalizedPhone) {
    const error = new Error("A valid WhatsApp phone number is required.");
    error.status = 400;
    throw error;
  }
  const components = [];
  if (imageMediaId) components.push(templateImageHeaderComponent(imageMediaId));
  if (bodyValues.length) components.push(templateBodyComponent(bodyValues));
  const response = await fetch(`https://graph.facebook.com/${whatsappApiVersion}/${whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${whatsappAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "WhatsApp template message failed.");
    error.status = response.status;
    error.details = payload?.error || null;
    throw error;
  }
  return payload;
}

app.get("/api/state", async (req, res, next) => {
  try {
    res.json(await readDb());
  } catch (error) {
    next(error);
  }
});

app.get("/api/customers/export.csv", async (req, res, next) => {
  try {
    const db = await readDb();
    const csv = toCsv(db.customers, [
      { label: "Name", value: (customer) => customer.name },
      { label: "Phone", value: (customer) => customer.phone },
      { label: "Address", value: (customer) => customer.address },
      { label: "GSTIN", value: (customer) => customer.gstin },
      { label: "State Code", value: (customer) => customer.stateCode },
      { label: "WhatsApp Opt In", value: (customer) => customer.whatsappOptIn ? "Yes" : "No" },
      { label: "WhatsApp Opt In Date", value: (customer) => customer.whatsappOptInAt || "" },
      { label: "Invoice Count", value: (customer) => customer.invoiceCount },
      { label: "Total Spent", value: (customer) => Number(customer.totalSpent || 0).toFixed(2) },
      { label: "Last Purchase", value: (customer) => customer.lastPurchase },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="alter-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customers", async (req, res, next) => {
  try {
    const db = await readDb();
    const customer = {
      name: String(req.body.name || "").trim(),
      phone: String(req.body.phone || "").trim(),
      address: String(req.body.address || "").trim(),
      gstin: String(req.body.gstin || "").trim().toUpperCase(),
      stateCode: String(req.body.stateCode || "").trim(),
      whatsappOptIn: Boolean(req.body.whatsappOptIn),
      whatsappOptInAt: req.body.whatsappOptIn ? String(req.body.whatsappOptInAt || new Date().toISOString()) : "",
    };
    if (!customer.name) {
      res.status(400).json({ error: "Customer name is required." });
      return;
    }

    const key = customerKey(customer);
    if (db.customers.some((item) => item.key === key || customerKey(item) === key)) {
      res.status(409).json({ error: "Customer already exists." });
      return;
    }

    const savedCustomer = {
      key,
      ...customer,
      invoiceCount: 0,
      totalSpent: 0,
      lastPurchase: "",
      source: "manual",
    };
    db.customers.push(savedCustomer);

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("customers").insertOne(savedCustomer);
    } else {
      await writeDb(db);
    }

    res.status(201).json(savedCustomer);
  } catch (error) {
    next(error);
  }
});

app.put("/api/customers/:key", async (req, res, next) => {
  try {
    const db = await readDb();
    const oldKey = decodeURIComponent(req.params.key);
    const updatedCustomer = {
      name: String(req.body.name || "").trim(),
      phone: String(req.body.phone || "").trim(),
      address: String(req.body.address || "").trim(),
      gstin: String(req.body.gstin || "").trim().toUpperCase(),
      stateCode: String(req.body.stateCode || "").trim(),
      whatsappOptIn: Boolean(req.body.whatsappOptIn),
      whatsappOptInAt: req.body.whatsappOptIn ? String(req.body.whatsappOptInAt || new Date().toISOString()) : "",
    };
    if (!updatedCustomer.name) {
      res.status(400).json({ error: "Customer name is required." });
      return;
    }

    const newKey = customerKey(updatedCustomer);
    if (db.customers.some((item) => item.key !== oldKey && customerKey(item) === newKey)) {
      res.status(409).json({ error: "Another customer already uses these details." });
      return;
    }

    const existingCustomer = db.customers.find((item) => item.key === oldKey || customerKey(item) === oldKey);
    const affectedInvoices = db.invoices.filter((invoice) => {
      return customerKey(invoice.customer) === oldKey;
    });
    if (!affectedInvoices.length && !existingCustomer) {
      res.status(404).json({ error: "Customer was not found." });
      return;
    }

    for (const invoice of affectedInvoices) {
      invoice.customer = { ...invoice.customer, ...updatedCustomer };
      invoice.editedAt = new Date().toISOString();
    }
    if (existingCustomer) {
      Object.assign(existingCustomer, {
        ...updatedCustomer,
        key: newKey,
        source: existingCustomer.source || "manual",
      });
    }
    rebuildCustomers(db);
    const customer = db.customers.find((item) => {
      return customerKey(item) === newKey;
    });

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await Promise.all([
        replaceMongoCollection(mongoDb, "invoices", db.invoices),
        replaceMongoCollection(mongoDb, "customers", db.customers),
      ]);
    } else {
      await writeDb(db);
    }

    res.json(customer);
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const db = await readDb();
    db.settings = {
      ...db.settings,
      shopName: String(req.body.shopName || "Alter").trim(),
      shopPhone: String(req.body.shopPhone || "").trim(),
      shopAddress: String(req.body.shopAddress || "").trim(),
      shopGstin: String(req.body.shopGstin || "").trim(),
      firmName: String(req.body.firmName || "").trim(),
      firmPhone: String(req.body.firmPhone || "").trim(),
      firmAddress: String(req.body.firmAddress || "").trim(),
      firmGstin: String(req.body.firmGstin || "").trim(),
      firmStateCode: String(req.body.firmStateCode || "").trim(),
      upiId: String(req.body.upiId || "Q925031435@ybl").trim(),
      invoicePrefix: String(req.body.invoicePrefix || "ALT").trim().toUpperCase(),
      receiptFooter: String(req.body.receiptFooter || "").trim(),
    };
    await writeDb(db);
    res.json(db.settings);
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", async (req, res, next) => {
  try {
    const db = await readDb();
    const existing = db.products.find((item) => item.id === req.body.id);
    const product = normalizeProduct(req.body, existing);
    if (!product.name || !product.barcode || product.price <= 0) {
      res.status(400).json({ error: "Product name, barcode, and price are required." });
      return;
    }
    const duplicate = db.products.find((item) => item.barcode === product.barcode && item.id !== product.id);
    if (duplicate) {
      res.status(409).json({ error: "Another product already uses this barcode." });
      return;
    }
    if (req.body.removeImage) {
      await deleteProductImage(existing?.imageUrl);
      product.imageUrl = "";
    } else if (req.body.imageData) {
      product.imageUrl = await saveProductImage(product.id, req.body.imageData, existing?.imageUrl);
    }
    const index = db.products.findIndex((item) => item.id === product.id);
    if (index >= 0) db.products[index] = product;
    else db.products.push(product);
    await writeDb(db);
    res.json(product);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/products/:id", async (req, res, next) => {
  try {
    const db = await readDb();
    const product = db.products.find((item) => item.id === req.params.id);
    await deleteProductImage(product?.imageUrl);
    db.products = db.products.filter((product) => product.id !== req.params.id);
    await writeDb(db);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoices", async (req, res, next) => {
  try {
    const db = await readDb();
    const validationError = validateInvoiceInput(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    const invoice = buildInvoice(db, req.body, { id: await invoiceId(db) });
    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("invoices").insertOne(invoice);
      await upsertCustomerInMongo(invoice);
      await adjustMongoStock(invoiceStockChanges(invoice, -1));
    } else {
      db.invoices.push(invoice);
      upsertCustomer(db, invoice);
      adjustLocalStock(db.products, invoiceStockChanges(invoice, -1));
      await writeDb(db);
    }
    res.json(invoice);
  } catch (error) {
    next(error);
  }
});

app.put("/api/invoices/:id", async (req, res, next) => {
  try {
    const db = await readDb();
    const existing = db.invoices.find((invoice) => invoice.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Invoice was not found." });
      return;
    }
    if (db.returns.some((record) => record.invoiceId === existing.id)) {
      res.status(409).json({ error: "Invoices with returns or exchanges cannot be edited." });
      return;
    }
    const validationError = validateInvoiceInput(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const invoice = {
      ...buildInvoice(db, req.body, { id: existing.id, date: existing.date }),
      editedAt: new Date().toISOString(),
    };
    const invoiceIndex = db.invoices.findIndex((item) => item.id === existing.id);
    db.invoices[invoiceIndex] = invoice;
    rebuildCustomers(db);

    const stockChanges = [
      ...invoiceStockChanges(existing, 1),
      ...invoiceStockChanges(invoice, -1),
    ];

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("invoices").replaceOne({ id: existing.id }, invoice);
      await replaceMongoCustomers(db.invoices, db.customers);
      await adjustMongoStock(stockChanges);
    } else {
      adjustLocalStock(db.products, stockChanges);
      await writeDb(db);
    }

    res.json(invoice);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/invoices/:id", async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find((item) => item.id === req.params.id);
    if (!invoice) {
      res.status(404).json({ error: "Invoice was not found." });
      return;
    }
    if (db.returns.some((record) => record.invoiceId === invoice.id)) {
      res.status(409).json({ error: "Invoices with returns or exchanges cannot be deleted." });
      return;
    }

    db.invoices = db.invoices.filter((item) => item.id !== invoice.id);
    rebuildCustomers(db);
    const stockChanges = invoiceStockChanges(invoice, 1);

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("invoices").deleteOne({ id: invoice.id });
      await replaceMongoCustomers(db.invoices, db.customers);
      await adjustMongoStock(stockChanges);
    } else {
      adjustLocalStock(db.products, stockChanges);
      await writeDb(db);
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/returns", async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find((item) => item.id === req.body.invoiceId);
    if (!invoice) {
      res.status(404).json({ error: "Original invoice was not found." });
      return;
    }
    const type = req.body.type === "exchange" ? "exchange" : "return";
    const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
    const returnedItems = [];

    for (const requested of requestedItems) {
      const itemIndex = Number(requested.itemIndex);
      const original = invoice.items[itemIndex];
      const qty = Math.max(0, Number(requested.qty) || 0);
      if (!original || qty <= 0) continue;
      const previouslyReturned = db.returns
        .filter((record) => record.invoiceId === invoice.id)
        .flatMap((record) => record.items)
        .filter((item) => item.itemIndex === itemIndex)
        .reduce((sum, item) => sum + Number(item.qty || 0), 0);
      const available = Math.max(0, Number(original.qty || 0) - previouslyReturned);
      if (qty > available) {
        res.status(400).json({ error: `${original.name} only has ${available} available to return.` });
        return;
      }
      const lineCredit = invoiceLineCredit(invoice, original);
      const credit = Number(original.qty || 0) > 0 ? (lineCredit / Number(original.qty)) * qty : 0;
      returnedItems.push({
        itemIndex,
        productId: original.productId || "",
        name: original.name,
        barcode: original.barcode || "",
        qty,
        unitCredit: credit / qty,
        credit,
      });
    }

    if (!returnedItems.length) {
      res.status(400).json({ error: "Select at least one item quantity to return." });
      return;
    }

    const replacements = [];
    if (type === "exchange") {
      for (const requested of Array.isArray(req.body.replacements) ? req.body.replacements : []) {
        const product = db.products.find((item) => item.id === requested.productId);
        const qty = Math.max(1, Number(requested.qty) || 1);
        const name = product?.name || String(requested.name || "").trim();
        const price = product ? Number(product.price || 0) : Math.max(0, Number(requested.price) || 0);
        if (!product && (!name || price <= 0)) {
          res.status(400).json({ error: "Manual replacement items need a name and price." });
          return;
        }
        const gross = qty * price;
        const discount = Math.min(gross, Math.max(0, Number(requested.discount) || 0));
        replacements.push({
          productId: product?.id || String(requested.productId || `manual-${Date.now()}`),
          name,
          barcode: product?.barcode || String(requested.barcode || "").trim(),
          hsnCode: product?.hsnCode || String(requested.hsnCode || "").trim(),
          gstRate: product ? Number(product.gstRate || 0) : Math.max(0, Number(requested.gstRate) || 0),
          qty,
          price,
          cost: product ? Number(product.cost || 0) : Math.max(0, Number(requested.cost) || 0),
          discount,
          discountMode: requested.discountMode === "fixed" ? "fixed" : "percentage",
          discountValue: Math.max(0, Number(requested.discountValue) || 0),
          amount: gross - discount,
          manual: !product,
        });
      }
      if (!replacements.length) {
        res.status(400).json({ error: "Add at least one replacement product for an exchange." });
        return;
      }
      if (invoice.invoiceType === "gst" && replacements.some((item) => !item.hsnCode || Number(item.gstRate || 0) <= 0)) {
        res.status(400).json({ error: "GST exchange replacements need an HSN code and GST rate." });
        return;
      }
    }

    const creditTotal = returnedItems.reduce((sum, item) => sum + item.credit, 0);
    const replacementTotal = replacements.reduce((sum, item) => sum + item.amount, 0);
    const record = {
      id: await returnId(db),
      date: new Date().toISOString(),
      type,
      invoiceId: invoice.id,
      customer: { ...invoice.customer },
      shop: { ...db.settings },
      items: returnedItems,
      replacements,
      reason: String(req.body.reason || "").trim(),
      settlementMode: String(req.body.settlementMode || "Cash").trim(),
      creditTotal,
      replacementTotal,
      difference: replacementTotal - creditTotal,
    };
    let exchangeInvoice = null;
    if (type === "exchange") {
      record.exchangeInvoiceId = await invoiceId(db);
      exchangeInvoice = buildExchangeInvoice(db, invoice, replacements, record);
    }

    for (const item of returnedItems) {
      const product = db.products.find((candidate) => candidate.id === item.productId || candidate.barcode === item.barcode);
      if (product) product.stock = Number(product.stock || 0) + item.qty;
    }
    for (const item of replacements) {
      if (item.manual) continue;
      const product = db.products.find((candidate) => candidate.id === item.productId);
      if (product) product.stock = Math.max(0, Number(product.stock || 0) - item.qty);
    }

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("returns").insertOne(record);
      if (exchangeInvoice) {
        await mongoDb.collection("invoices").insertOne(exchangeInvoice);
        await upsertCustomerInMongo(exchangeInvoice);
      }
      await adjustMongoStock([
        ...returnedItems.map((item) => ({
          productId: item.productId,
          barcode: item.barcode,
          qty: item.qty,
        })),
        ...replacements.map((item) => ({
          productId: item.productId,
          barcode: item.barcode,
          qty: item.manual ? 0 : -item.qty,
        })).filter((item) => item.qty !== 0),
      ]);
    } else {
      db.returns.push(record);
      if (exchangeInvoice) {
        db.invoices.push(exchangeInvoice);
        upsertCustomer(db, exchangeInvoice);
      }
      await writeDb(db);
    }
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.post("/api/clear-records", async (req, res, next) => {
  try {
    const db = await readDb();
    db.customers = [];
    db.invoices = [];
    db.returns = [];
    await writeDb(db);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/whatsapp/status", (req, res) => {
  res.json({ configured: whatsappConfigured() });
});

app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === whatsappWebhookVerifyToken) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

app.post("/api/whatsapp/webhook", async (req, res, next) => {
  try {
    const db = await readDb();
    const events = parseWhatsAppWebhookEvents(db, req.body || {});
    const webhookLog = {
      id: makeId("whl"),
      timestamp: new Date().toISOString(),
      eventCount: events.length,
      incomingCount: events.filter((event) => event.direction === "incoming").length,
      statusCount: events.filter((event) => event.direction === "status").length,
      fields: [...new Set((req.body?.entry || []).flatMap((entry) => (entry.changes || []).map((change) => change.field || "unknown")))],
      object: req.body?.object || "",
      sample: {
        messages: events.filter((event) => event.direction === "incoming").slice(0, 3).map((event) => ({
          from: event.from,
          text: event.text,
          type: event.type,
        })),
        statuses: events.filter((event) => event.direction === "status").slice(0, 5).map((event) => ({
          to: event.to,
          status: event.status,
          text: event.text,
        })),
      },
    };
    db.whatsappWebhookLogs = [webhookLog, ...(db.whatsappWebhookLogs || [])].slice(0, 50);
    if (events.length) {
      const existingKeys = new Set((db.whatsappMessages || []).map(whatsappStoredEventKey));
      const newEvents = events.filter((event) => !existingKeys.has(whatsappStoredEventKey(event)));
      db.whatsappMessages = [...(db.whatsappMessages || []), ...newEvents]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 1000);
      if (mongoUri) {
        const mongoDb = await getMongoDb();
        await mongoDb.collection("whatsappWebhookLogs").insertOne(webhookLog);
        if (newEvents.length) await mongoDb.collection("whatsappMessages").insertMany(newEvents);
      } else {
        await writeDb(db);
      }
    } else if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("whatsappWebhookLogs").insertOne(webhookLog);
    } else {
      await writeDb(db);
    }
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customers/whatsapp-opt-in", async (req, res, next) => {
  try {
    const db = await readDb();
    const optInAt = new Date().toISOString();
    let updated = 0;
    for (const invoice of db.invoices) {
      if (!invoice.customer?.phone) continue;
      if (!invoice.customer.whatsappOptIn) updated += 1;
      invoice.customer.whatsappOptIn = true;
      invoice.customer.whatsappOptInAt = invoice.customer.whatsappOptInAt || optInAt;
      invoice.editedAt = optInAt;
    }
    for (const customer of db.customers) {
      if (!customer.phone) continue;
      if (!customer.whatsappOptIn) updated += 1;
      customer.whatsappOptIn = true;
      customer.whatsappOptInAt = customer.whatsappOptInAt || optInAt;
    }
    rebuildCustomers(db);
    for (const customer of db.customers) {
      if (customer.phone) {
        customer.whatsappOptIn = true;
        customer.whatsappOptInAt = customer.whatsappOptInAt || optInAt;
      }
    }
    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await Promise.all([
        replaceMongoCollection(mongoDb, "invoices", db.invoices),
        replaceMongoCollection(mongoDb, "customers", db.customers),
      ]);
    } else {
      await writeDb(db);
    }
    res.json({ ok: true, updated, customers: db.customers });
  } catch (error) {
    next(error);
  }
});

app.post("/api/whatsapp/send-invoice", async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find((item) => item.id === req.body.invoiceId);
    if (!invoice) {
      res.status(404).json({ error: "Invoice was not found." });
      return;
    }
    const phone = req.body.phone || invoice.customer?.phone;
    if (!phone) {
      res.status(400).json({ error: "Customer phone number is required." });
      return;
    }
    const result = await sendWhatsAppTemplate({
      to: phone,
      templateName: whatsappInvoiceTemplate,
      bodyValues: [
        invoice.customer?.name || "Customer",
        invoice.id,
        `₹${formatCurrency(invoice.totals?.total)}`,
      ],
    });
    res.json({ ok: true, messageId: result?.messages?.[0]?.id || "", mode: "template", template: whatsappInvoiceTemplate });
  } catch (error) {
    next(error);
  }
});

app.post("/api/whatsapp/send-campaign", async (req, res, next) => {
  try {
    const db = await readDb();
    const imageData = String(req.body.imageData || "");
    const campaignMode = req.body.templateMode === "generic" ? "generic" : "new_arrivals";
    const message = String(req.body.message || "").trim();
    const templateName = campaignMode === "generic" ? whatsappGenericTemplate : whatsappPromotionTemplate;
    const requestedKeys = Array.isArray(req.body.recipientKeys)
      ? req.body.recipientKeys.map((key) => String(key || "")).filter(Boolean)
      : [];
    if (campaignMode === "generic" && !message) {
      res.status(400).json({ error: "Message is required for the generic WhatsApp template." });
      return;
    }
    const allRecipients = db.customers.filter((customer) => customer.whatsappOptIn && normalizeWhatsAppPhone(customer.phone));
    const requestedKeySet = new Set(requestedKeys);
    const recipients = requestedKeys.length
      ? allRecipients.filter((customer) => requestedKeySet.has(customer.key))
      : allRecipients;
    if (!recipients.length) {
      res.status(400).json({
        error: requestedKeys.length
          ? "No selected WhatsApp opted-in customers with phone numbers found."
          : "No WhatsApp opted-in customers with phone numbers found.",
      });
      return;
    }
    const mediaId = imageData ? await uploadWhatsAppImage(imageData) : "";
    const results = [];
    for (const customer of recipients) {
      const normalizedPhone = normalizeWhatsAppPhone(customer.phone);
      try {
        const result = await sendWhatsAppTemplate({
          to: customer.phone,
          templateName,
          bodyValues: campaignMode === "generic" ? [customer.name || "Customer", message] : [customer.name || "Customer"],
          imageMediaId: mediaId,
        });
        results.push({
          key: customer.key,
          name: customer.name,
          phone: customer.phone,
          normalizedPhone,
          ok: true,
          status: "accepted",
          messageId: result?.messages?.[0]?.id || "",
          mode: "template",
        });
      } catch (error) {
        results.push({
          key: customer.key,
          name: customer.name,
          phone: customer.phone,
          normalizedPhone,
          ok: false,
          status: "failed",
          error: error.message,
          errorCode: error.details?.code || "",
          errorSubcode: error.details?.error_subcode || "",
        });
      }
    }
    const acceptedEvents = results
      .filter((result) => result.ok)
      .map((result) => ({
        id: result.messageId ? `out-${result.messageId}` : makeId("wao"),
        direction: "outgoing",
        from: whatsappPhoneNumberId,
        to: result.normalizedPhone,
        customerKey: result.key,
        customerName: result.name,
        type: "template",
        text: campaignMode === "generic" ? message : `Campaign template: ${templateName}`,
        status: "accepted",
        timestamp: new Date().toISOString(),
        raw: {
          template: templateName,
          campaignMode,
          messageId: result.messageId,
        },
      }));
    if (acceptedEvents.length) {
      db.whatsappMessages = [...acceptedEvents, ...(db.whatsappMessages || [])]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 1000);
      if (mongoUri) {
        const mongoDb = await getMongoDb();
        await mongoDb.collection("whatsappMessages").insertMany(acceptedEvents);
      } else {
        await writeDb(db);
      }
    }
    res.json({
      ok: results.some((result) => result.ok),
      attempted: recipients.length,
      sent: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      mode: "template",
      campaignMode,
      template: templateName,
      results,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/backup", async (req, res, next) => {
  try {
    const db = await readDb();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="alter-billing-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(db, null, 2));
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, "dist");
app.use(express.static(distDir));
app.use(async (req, res) => {
  try {
    await fs.access(path.join(distDir, "index.html"));
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    res.status(404).send("Run npm run client for the React app, or npm run build before preview.");
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Something went wrong." });
});

app.listen(port, () => {
  console.log(`Alter API running on http://localhost:${port}`);
});
