import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dbPath = path.join(rootDir, "data", "db.json");
try {
  loadEnvFile(path.join(rootDir, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || "alter-billing";

if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const localDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
const client = new MongoClient(uri);

function asList(value) {
  return Array.isArray(value) ? value : [];
}

async function replaceCollection(db, collectionName, records, key = "id") {
  const collection = db.collection(collectionName);
  if (!records.length) return { collection: collectionName, count: 0 };

  await collection.bulkWrite(
    records.map((record) => ({
      replaceOne: {
        filter: { [key]: record[key] },
        replacement: record,
        upsert: true,
      },
    }))
  );

  return { collection: collectionName, count: records.length };
}

try {
  await client.connect();
  const db = client.db(databaseName);

  const results = [];
  results.push(await replaceCollection(db, "products", asList(localDb.products)));
  results.push(await replaceCollection(db, "customers", asList(localDb.customers), "key"));
  results.push(await replaceCollection(db, "invoices", asList(localDb.invoices)));
  results.push(await replaceCollection(db, "returns", asList(localDb.returns)));

  await db.collection("settings").replaceOne(
    { id: "settings" },
    { id: "settings", ...(localDb.settings || {}) },
    { upsert: true }
  );
  results.push({ collection: "settings", count: localDb.settings ? 1 : 0 });

  console.table(results);
  console.log(`Uploaded local Alter billing data to MongoDB database "${databaseName}".`);
} finally {
  await client.close();
}
