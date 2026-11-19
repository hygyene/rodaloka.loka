import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));

// --- Server-Side Gemini Client ---
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi pada server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// --- API: Deep Thinking Analysis (gemini-4-carbon + ThinkingLevel.HIGH) ---
app.post('/api/ai/analyze', async (req: Request, res: Response) => {
  try {
    const { mode, query, contextData } = req.body as {
      mode?: 'vendor_strategy' | 'buyer_planner';
      query?: string;
      contextData?: Record<string, unknown>;
    };

    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Pertanyaan analisis tidak boleh kosong.' });
      return;
    }

    const ai = getGeminiClient();

    const systemInstruction =
      mode === 'vendor_strategy'
        ? 'Anda adalah konsultan strategi bisnis kuliner kaki lima & UMKM Indonesia untuk aplikasi RODALOKA. Analisis data toko, katalog produk, stok, harga, dan riwayat pesanan secara mendalam. Berikan rekomendasi konkret, terukur dalam Rupiah, praktis untuk pedagang gerobak/kaki lima, dan tersusun rapi dalam Bahasa Indonesia yang jelas.'
        : 'Anda adalah kurator kuliner kaki lima & perencana pesan-antar cerdas untuk aplikasi RODALOKA. Gunakan data pedagang terdekat, jarak Haversine, rating, menu, stok, dan harga yang tersedia untuk menyusun rekomendasi pesanan paling optimal sesuai anggaran, jumlah porsi, dan preferensi pengguna dalam Bahasa Indonesia yang ringkas dan aplikatif.';

    const prompt = `Pertanyaan Pengguna:\n${query.trim()}\n\nKonteks Data RODALOKA Saat Ini (JSON):\n${JSON.stringify(contextData ?? {}, null, 2)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-carbon',
      contents: prompt,
      config: {
        systemInstruction,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.HIGH,
        },
      },
    });

    res.json({
      analysis: response.text ?? 'Tidak ada hasil analisis yang dikembalikan.',
      model: 'gemini-4-carbon',
      thinkingLevel: 'HIGH',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    let status = 500;
    let userMessage = `Gagal menjalankan analisis cerdas: ${message}`;

    if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
      status = 429;
      userMessage =
        'Kuota API untuk model analisis mendalam (gemini-4-carbon) terbatas pada paket gratis. Anda dapat memilih API key berbayar di panel Settings > Secrets untuk kuota penuh.';
    } else if (lower.includes('403') || lower.includes('permission_denied') || lower.includes('api_key_invalid') || lower.includes('400')) {
      status = 403;
      userMessage =
        'API key belum valid atau tidak memiliki akses ke model gemini-4-carbon. Periksa API key Anda di panel Settings > Secrets.';
    }

    console.error('[Gemini Analyze Error]:', message);
    res.status(status).json({ error: userMessage });
  }
});

// --- Google Sheets Helper (8 Relational Tabs from RODALOKA Blueprint) ---
const SHEET_HEADERS: Record<string, string[]> = {
  Users: [
    'user_id',
    'full_name',
    'phone_number',
    'email',
    'auth_provider',
    'active_role',
    'avatar_url',
    'saved_addresses',
    'created_at',
  ],
  Vendors: [
    'vendor_id',
    'user_id',
    'shop_name',
    'username',
    'category',
    'description',
    'address_text',
    'lat_lng',
    'operating_hours',
    'is_open',
    'rating_avg',
    'media_json',
    'bank_json',
    'courier_json',
  ],
  Products: [
    'product_id',
    'vendor_id',
    'product_name',
    'description',
    'category',
    'price',
    'stock',
    'is_available',
    'image_url',
    'sold_count',
  ],
  Orders: [
    'order_id',
    'buyer_id',
    'vendor_id',
    'delivery_address',
    'subtotal',
    'delivery_fee',
    'total_amount',
    'payment_method',
    'payment_status',
    'order_status',
    'buyer_note',
    'eta_minutes',
    'created_at',
  ],
  Order_Items: ['item_id', 'order_id', 'product_id', 'product_name', 'qty', 'unit_price', 'line_total'],
  Favorites: ['fav_id', 'user_id', 'vendor_id', 'created_at'],
  Promos: ['promo_id', 'title', 'subtitle', 'banner_url', 'discount_pct', 'is_active'],
  Notifications: ['notif_id', 'user_id', 'category', 'title', 'body', 'is_read', 'created_at'],
};

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

// Create new 8-tab RODALOKA_DB spreadsheet and write initial snapshot
app.post('/api/sheets/bootstrap', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Token Google Sheets tidak ditemukan. Silakan masuk dengan Google.' });
      return;
    }

    const { title = 'RODALOKA_DB', rowsBySheet = {} } = req.body as {
      title?: string;
      rowsBySheet?: Record<string, (string | number | boolean)[][]>;
    };

    const sheetNames = Object.keys(SHEET_HEADERS);

    // 1. Create spreadsheet with all 8 tabs
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: { title },
        sheets: sheetNames.map((name, idx) => ({
          properties: {
            title: name,
            index: idx,
            gridProperties: { frozenRowCount: 1 },
          },
        })),
      }),
    });

    const created = (await createRes.json()) as {
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      error?: { message?: string };
    };

    if (!createRes.ok || !created.spreadsheetId) {
      res.status(createRes.status).json({
        error: created.error?.message || 'Gagal membuat Google Spreadsheet RODALOKA_DB.',
      });
      return;
    }

    // 2. Batch write headers + rows for all 8 sheets
    const dataPayload = sheetNames.map((sheetName) => {
      const headers = SHEET_HEADERS[sheetName];
      const dataRows = Array.isArray(rowsBySheet[sheetName]) ? rowsBySheet[sheetName] : [];
      return {
        range: `${sheetName}!A1`,
        values: [headers, ...dataRows],
      };
    });

    const batchRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(created.spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: dataPayload,
        }),
      },
    );

    if (!batchRes.ok) {
      const errJson = (await batchRes.json().catch(() => ({}))) as { error?: { message?: string } };
      res.status(batchRes.status).json({
        error: errJson.error?.message || 'Spreadsheet dibuat tetapi gagal menulis data awal.',
        spreadsheetId: created.spreadsheetId,
        spreadsheetUrl: created.spreadsheetUrl,
      });
      return;
    }

    res.json({
      spreadsheetId: created.spreadsheetId,
      spreadsheetUrl: created.spreadsheetUrl,
      sheets: sheetNames,
      syncedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    console.error('[Sheets Bootstrap Error]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Kesalahan server Google Sheets.' });
  }
});

// Sync/update existing spreadsheet tabs (metadata-aware, never assumes Sheet1)
app.post('/api/sheets/sync', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Token Google Sheets tidak ditemukan. Silakan masuk dengan Google.' });
      return;
    }

    const { spreadsheetId, rowsBySheet = {} } = req.body as {
      spreadsheetId?: string;
      rowsBySheet?: Record<string, (string | number | boolean)[][]>;
    };

    if (!spreadsheetId) {
      res.status(400).json({ error: 'spreadsheetId wajib diisi.' });
      return;
    }

    // Fetch existing sheet metadata first (per Google Sheets best practices)
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,spreadsheetUrl,sheets.properties.title`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const meta = (await metaRes.json()) as {
      properties?: { title?: string };
      spreadsheetUrl?: string;
      sheets?: { properties?: { title?: string } }[];
      error?: { message?: string };
    };

    if (!metaRes.ok) {
      res.status(metaRes.status).json({
        error: meta.error?.message || 'Gagal membaca metadata Google Spreadsheet.',
      });
      return;
    }

    const existingTitles = new Set(
      (meta.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => Boolean(t)),
    );
    const missingTabs = Object.keys(SHEET_HEADERS).filter((name) => !existingTitles.has(name));

    if (missingTabs.length > 0) {
      const addRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: missingTabs.map((title) => ({
              addSheet: {
                properties: {
                  title,
                  gridProperties: { frozenRowCount: 1 },
                },
              },
            })),
          }),
        },
      );
      if (!addRes.ok) {
        const errBody = (await addRes.json().catch(() => ({}))) as { error?: { message?: string } };
        res.status(addRes.status).json({
          error: errBody.error?.message || 'Gagal menambahkan lembar kerja yang hilang.',
        });
        return;
      }
    }

    // Clear old values cleanly then write updated rows
    const sheetNames = Object.keys(SHEET_HEADERS);
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ranges: sheetNames.map((n) => `${n}!A:Z`),
        }),
      },
    );

    const dataPayload = sheetNames.map((sheetName) => {
      const headers = SHEET_HEADERS[sheetName];
      const dataRows = Array.isArray(rowsBySheet[sheetName]) ? rowsBySheet[sheetName] : [];
      return {
        range: `${sheetName}!A1`,
        values: [headers, ...dataRows],
      };
    });

    const updateRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: dataPayload,
        }),
      },
    );

    if (!updateRes.ok) {
      const errBody = (await updateRes.json().catch(() => ({}))) as { error?: { message?: string } };
      res.status(updateRes.status).json({
        error: errBody.error?.message || 'Gagal menyinkronkan data ke Google Sheets.',
      });
      return;
    }

    res.json({
      spreadsheetId,
      title: meta.properties?.title || 'RODALOKA_DB',
      spreadsheetUrl: meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      sheets: sheetNames,
      syncedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    console.error('[Sheets Sync Error]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Kesalahan sinkronisasi Sheets.' });
  }
});

// Read live spreadsheet metadata & row counts
app.get('/api/sheets/status/:spreadsheetId', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Token Google Sheets tidak tersedia.' });
      return;
    }
    const { spreadsheetId } = req.params;
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,spreadsheetUrl,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const meta = (await metaRes.json()) as {
      properties?: { title?: string };
      spreadsheetUrl?: string;
      sheets?: { properties?: { title?: string } }[];
      error?: { message?: string };
    };
    if (!metaRes.ok) {
      res.status(metaRes.status).json({ error: meta.error?.message || 'Spreadsheet tidak ditemukan.' });
      return;
    }

    const titles = (meta.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));

    const counts: Record<string, number> = {};
    if (titles.length > 0) {
      const rangesQuery = titles.map((t) => `ranges=${encodeURIComponent(`${t}!A:A`)}`).join('&');
      const valRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${rangesQuery}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (valRes.ok) {
        const valData = (await valRes.json()) as { valueRanges?: { values?: unknown[][] }[] };
        titles.forEach((t, i) => {
          const rows = valData.valueRanges?.[i]?.values?.length ?? 0;
          counts[t] = Math.max(0, rows - 1);
        });
      }
    }

    res.json({
      spreadsheetId,
      title: meta.properties?.title || 'RODALOKA_DB',
      spreadsheetUrl: meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      tabs: titles,
      rowCounts: counts,
    });
  } catch (err: unknown) {
    console.error('[Sheets Status Error]:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal memeriksa status spreadsheet.' });
  }
});

// --- Mount Vite Dev Middleware or Static Production Build ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RODALOKA server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
