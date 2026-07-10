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
  const [settings, products, customers, invoices, returns] = await Promise.all([
    db.collection("settings").findOne({ id: "settings" }, { projection: { _id: 0 } }),
    db.collection("products").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("customers").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("invoices").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection("returns").find({}, { projection: { _id: 0 } }).toArray(),
  ]);

  return normalizeDb({ settings, products, customers, invoices, returns });
}

async function writeMongoDb(appDb) {
  const db = await getMongoDb();
  const normalized = normalizeDb(appDb);
  await Promise.all([
    replaceMongoCollection(db, "products", normalized.products),
    replaceMongoCollection(db, "customers", normalized.customers),
    replaceMongoCollection(db, "invoices", normalized.invoices),
    replaceMongoCollection(db, "returns", normalized.returns),
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
    },
    items: items.map((item) => ({
      productId: item.productId || "",
      name: String(item.name || "").trim(),
      barcode: String(item.barcode || "").trim(),
      hsnCode: String(item.hsnCode || "").trim(),
      gstRate: Math.max(0, Number(item.gstRate) || 0),
      qty: Math.max(1, Number(item.qty) || 1),
      price: Math.max(0, Number(item.price) || 0),
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
    existing.invoiceCount += 1;
    existing.totalSpent += invoice.totals.total;
    existing.lastPurchase = invoice.date;
    return;
  }
  db.customers.push({
    key,
    name: invoice.customer.name,
    phone: invoice.customer.phone,
    address: invoice.customer.address,
    invoiceCount: 1,
    totalSpent: invoice.totals.total,
    lastPurchase: invoice.date,
  });
}

function summarizeCustomers(invoices) {
  const customers = new Map();
  for (const invoice of invoices) {
    const phone = invoice.customer.phone.trim();
    const key = phone || invoice.customer.name.trim().toLowerCase();
    if (!key) continue;
    const existing = customers.get(key);
    if (existing) {
      existing.name = invoice.customer.name;
      existing.phone = invoice.customer.phone;
      existing.address = invoice.customer.address;
      existing.invoiceCount += 1;
      existing.totalSpent += Number(invoice.totals.total || 0);
      if (invoice.date > existing.lastPurchase) existing.lastPurchase = invoice.date;
    } else {
      customers.set(key, {
        key,
        name: invoice.customer.name,
        phone: invoice.customer.phone,
        address: invoice.customer.address,
        invoiceCount: 1,
        totalSpent: Number(invoice.totals.total || 0),
        lastPurchase: invoice.date,
      });
    }
  }
  return [...customers.values()];
}

function rebuildCustomers(db) {
  db.customers = summarizeCustomers(db.invoices);
}

async function upsertCustomerInMongo(invoice) {
  const db = await getMongoDb();
  const phone = invoice.customer.phone.trim();
  const key = phone || invoice.customer.name.trim().toLowerCase();
  await db.collection("customers").updateOne(
    { key },
    {
      $set: {
        name: invoice.customer.name,
        phone: invoice.customer.phone,
        address: invoice.customer.address,
        lastPurchase: invoice.date,
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

async function replaceMongoCustomers(invoices) {
  const db = await getMongoDb();
  await replaceMongoCollection(db, "customers", summarizeCustomers(invoices));
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

app.get("/api/state", async (req, res, next) => {
  try {
    res.json(await readDb());
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
      await replaceMongoCustomers(db.invoices);
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
      await replaceMongoCustomers(db.invoices);
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
        if (!product) {
          res.status(400).json({ error: "One of the replacement products no longer exists." });
          return;
        }
        const gross = qty * Number(product.price || 0);
        const discount = Math.min(gross, Math.max(0, Number(requested.discount) || 0));
        replacements.push({
          productId: product.id,
          name: product.name,
          barcode: product.barcode,
          qty,
          price: Number(product.price || 0),
          discount,
          amount: gross - discount,
        });
      }
      if (!replacements.length) {
        res.status(400).json({ error: "Add at least one replacement product for an exchange." });
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

    for (const item of returnedItems) {
      const product = db.products.find((candidate) => candidate.id === item.productId || candidate.barcode === item.barcode);
      if (product) product.stock = Number(product.stock || 0) + item.qty;
    }
    for (const item of replacements) {
      const product = db.products.find((candidate) => candidate.id === item.productId);
      if (product) product.stock = Math.max(0, Number(product.stock || 0) - item.qty);
    }

    if (mongoUri) {
      const mongoDb = await getMongoDb();
      await mongoDb.collection("returns").insertOne(record);
      await adjustMongoStock([
        ...returnedItems.map((item) => ({
          productId: item.productId,
          barcode: item.barcode,
          qty: item.qty,
        })),
        ...replacements.map((item) => ({
          productId: item.productId,
          barcode: item.barcode,
          qty: -item.qty,
        })),
      ]);
    } else {
      db.returns.push(record);
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
  res.status(500).json({ error: error.message || "Something went wrong." });
});

app.listen(port, () => {
  console.log(`Alter API running on http://localhost:${port}`);
});
