import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");
const productImagesDir = path.join(dataDir, "product-images");
const port = Number(process.env.PORT || 4173);

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
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    const db = JSON.parse(raw);
    return {
      ...defaultDb,
      ...db,
      settings: { ...defaultDb.settings, ...db.settings },
      products: Array.isArray(db.products) ? db.products : [],
      customers: Array.isArray(db.customers) ? db.customers : [],
      invoices: Array.isArray(db.invoices) ? db.invoices : [],
      returns: Array.isArray(db.returns) ? db.returns : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeDb(defaultDb);
    return structuredClone(defaultDb);
  }
}

async function writeDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function invoiceId(db) {
  const prefix = db.settings.invoicePrefix || "ALT";
  return `${prefix}-${String(db.invoices.length + 1).padStart(5, "0")}`;
}

function returnId(db) {
  return `RET-${String(db.returns.length + 1).padStart(5, "0")}`;
}

function invoiceLineCredit(invoice, item) {
  const taxable = Number(item.taxable || 0);
  const gstAmount = Number(item.gstAmount || 0);
  if (invoice.invoiceType === "gst") return Math.max(0, taxable + gstAmount);
  if (taxable > 0) return taxable;
  return Math.max(0, Number(item.qty || 0) * Number(item.price || 0) - Number(item.discount || 0));
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
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!req.body.customer?.name?.trim() || !items.length) {
      res.status(400).json({ error: "Customer name and at least one item are required." });
      return;
    }
    const invoice = {
      id: invoiceId(db),
      date: new Date().toISOString(),
      customer: {
        name: String(req.body.customer.name || "").trim(),
        phone: String(req.body.customer.phone || "").trim(),
        address: String(req.body.customer.address || "").trim(),
        gstin: String(req.body.customer.gstin || "").trim(),
        stateCode: String(req.body.customer.stateCode || "").trim(),
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
      totals: req.body.totals,
      invoiceType: req.body.invoiceType === "gst" ? "gst" : "regular",
      gstType: req.body.gstType === "interstate" ? "interstate" : "intrastate",
      paymentMode: String(req.body.paymentMode || "Cash"),
      shop: { ...db.settings },
    };
    db.invoices.push(invoice);
    upsertCustomer(db, invoice);
    for (const line of invoice.items) {
      const product = db.products.find((item) => item.id === line.productId || item.barcode === line.barcode);
      if (product) product.stock = Math.max(0, Number(product.stock || 0) - line.qty);
    }
    await writeDb(db);
    res.json(invoice);
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
      id: returnId(db),
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

    db.returns.push(record);
    await writeDb(db);
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
