const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const multer = require('multer');
const xlsx = require('xlsx'); // Excel işlemleri için xlsx modülü
const upload = multer({ dest: 'uploads/' });
const { createTeklifPDF } = require('./pdfGenerator');
const logger = require('./utils/logger');

const app = express();
const port = 3001;

// Middleware
app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error', 
        message: process.env.NODE_ENV === 'development' ? err.message : undefined 
    });
});

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
    });
    next();
});

// UTF-8 karakter seti ayarları
app.use((req, res, next) => {
    res.charset = 'utf-8';
    next();
});

// Merkezi hata yönetimi
app.use((err, req, res, next) => {
    logger.error('Hata:', { 
        error: err.message,
        path: req.path,
        method: req.method,
        timestamp: new Date()
    });
    
    if (!res.headersSent) {
        res.status(500).json({ error: 'İşlem başarısız' });
    }
});

// Veritabanı bağlantısı ve tablo oluşturma
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Veritabanı bağlantı hatası:', err.message);
    } else {
        console.log('Veritabanına bağlandı.');
        
        // UTF-8 karakter seti ayarları
        db.run(`PRAGMA encoding = 'UTF-8'`);
        
        // Tabloları SADECE YOKSA oluştur (ilk kurulum)
        db.serialize(() => {
            db.run(`PRAGMA foreign_keys = ON`);
            
            // Müşteriler tablosu
            db.run(`CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('Müşteri', 'Tedarikçi', 'Fason', 'Diğer', 'Bioplant')),
                email TEXT,
                phone TEXT,
                address TEXT,
                balance REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME DEFAULT NULL
            )`);

            // Stok tablosu
            db.run(`CREATE TABLE IF NOT EXISTS stock (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                code TEXT DEFAULT NULL,
                quantity REAL DEFAULT 0,
                min_quantity REAL DEFAULT 0,
                unit TEXT DEFAULT 'kg',
                category TEXT DEFAULT 'hammadde',
                price REAL DEFAULT 0,
                created_at DATETIME DEFAULT (datetime('now')),
                updated_at DATETIME DEFAULT (datetime('now')),
                deleted_at DATETIME DEFAULT NULL
            )`);

            // Reçeteler tablosu (var olan tabloyu koru)
            db.run(`CREATE TABLE IF NOT EXISTS recipes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                customer_id INTEGER NOT NULL,
                density TEXT,
                total_cost REAL DEFAULT 0,
                is_price_updated BOOLEAN DEFAULT true,
                last_price_update DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME DEFAULT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id)
            )`);

            // last_price_update sütununu kontrol et ve yoksa ekle
            db.all("PRAGMA table_info(recipes)", [], (err, rows) => {
                if (!err) {
                    let hasLastPriceUpdate = false;
                    for (let i = 0; i < rows.length; i++) {
                        if (rows[i].name === 'last_price_update') {
                            hasLastPriceUpdate = true;
                            break;
                        }
                    }
                    if (!hasLastPriceUpdate) {
                        db.run(`ALTER TABLE recipes ADD COLUMN last_price_update DATETIME`);
                        console.log('last_price_update sütunu eklendi');
                    }
                }
            });

            // Ambalaj tablosu
            db.run(`CREATE TABLE IF NOT EXISTS packages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                size REAL NOT NULL,
                unit TEXT NOT NULL CHECK(unit IN ('L', 'Kg')),
                price REAL NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME DEFAULT NULL
            )`);

            // Siparişler tablosu
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER,
                recipe_id INTEGER,
                quantity REAL DEFAULT 0,
                charge_count REAL DEFAULT 0,
                total REAL DEFAULT 0,
                status TEXT CHECK(status IN ('Beklemede', 'Onaylandı', 'İptal')) DEFAULT 'Beklemede',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME DEFAULT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers (id),
                FOREIGN KEY (recipe_id) REFERENCES recipes (id)
            )`);
        });
    }
});

// Error handling for database operations
const dbRun = async (sql, params = []) => {
    try {
        return await new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) {
                    logger.error('Database error:', { sql, params, error: err.message });
                    reject(err);
                } else {
                    resolve(this);
                }
            });
        });
    } catch (err) {
        logger.error('Database operation failed:', { sql, params, error: err.message });
        throw err;
    }
};

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

// Veritabanı otomatik yedekleme fonksiyonu
const backupDatabaseBeforeReset = async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, 'backups', `pre_reset_${timestamp}.sqlite`);

    // Klasör yoksa oluştur
    if (!fs.existsSync(path.join(__dirname, 'backups'))) {
        fs.mkdirSync(path.join(__dirname, 'backups'));
    }

    try {
        // Veritabanı dosyasını kopyala
        fs.copyFileSync(
            path.join(__dirname, 'database.sqlite'),
            backupPath
        );
        console.log('Veritabanı yedeği oluşturuldu:', backupPath);
        return true;
    } catch (error) {
        console.error('Yedekleme hatası:', error);
        return false;
    }
};

// Veritabanı bağlantısı ve tablo oluşturma
const initializeDatabase = async () => {
    try {
        await dbRun('PRAGMA foreign_keys = ON');
        
        // Müşteriler tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('Müşteri', 'Tedarikçi', 'Fason', 'Diğer', 'Bioplant')),
            email TEXT,
            phone TEXT,
            address TEXT,
            balance REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL
        )`);

        // Stok tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT DEFAULT NULL,
            quantity REAL DEFAULT 0,
            min_quantity REAL DEFAULT 0,
            unit TEXT DEFAULT 'kg',
            category TEXT DEFAULT 'hammadde',
            price REAL DEFAULT 0,
            created_at DATETIME DEFAULT (datetime('now')),
            updated_at DATETIME DEFAULT (datetime('now')),
            deleted_at DATETIME DEFAULT NULL
        )`);

        // Stok boşsa varsayılan verileri ekle
        const stockCount = await dbGet('SELECT COUNT(*) as count FROM stock WHERE deleted_at IS NULL');
        if (stockCount.count === 0) {
            // Temel stok verilerini ekle
            const defaultStock = [
                { name: 'MAP', quantity: 1000, min_quantity: 100, price: 15.0 },
                { name: 'Potasyum Sülfat', quantity: 800, min_quantity: 100, price: 12.0 },
                { name: 'Üre', quantity: 1200, min_quantity: 150, price: 8.0 },
                { name: 'Amonyum Sülfat', quantity: 900, min_quantity: 100, price: 10.0 },
                { name: 'Magnezyum Sülfat', quantity: 500, min_quantity: 50, price: 9.0 }
            ];

            for (const item of defaultStock) {
                await dbRun(`
                    INSERT INTO stock (name, quantity, min_quantity, price)
                    SELECT ?, ?, ?, ?
                    WHERE NOT EXISTS (
                        SELECT 1 FROM stock WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL
                    )
                `, [item.name, item.quantity, item.min_quantity, item.price, item.name]);
            }
            console.log('Varsayılan stok verileri eklendi');
        }

        // Reçeteler tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS recipes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            customer_id INTEGER NOT NULL,
            density TEXT,
            total_cost REAL DEFAULT 0,
            is_price_updated BOOLEAN DEFAULT true,
            last_price_update DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL,
            FOREIGN KEY (customer_id) REFERENCES customers(id)
        )`);

        // Reçete paketleri tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS recipe_packages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipe_id INTEGER NOT NULL,
            package_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
            FOREIGN KEY (package_id) REFERENCES packages(id)
        )`);

        // Reçete içerikleri tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS recipe_ingredients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipe_id INTEGER NOT NULL,
            stock_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            total REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
            FOREIGN KEY (stock_id) REFERENCES stock(id)
        )`);

        // Ambalaj tablosu
        await dbRun(`CREATE TABLE IF NOT EXISTS packages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            size REAL NOT NULL,
            unit TEXT NOT NULL CHECK(unit IN ('L', 'Kg')),
            price REAL NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL
        )`);

        // Ambalaj boşsa varsayılan verileri ekle
        const packageCount = await dbGet('SELECT COUNT(*) as count FROM packages WHERE deleted_at IS NULL');
        if (packageCount.count === 0) {
            // Temel ambalaj verilerini ekle
            const defaultPackages = [
                { size: 1, unit: 'L', price: 2.5 },
                { size: 5, unit: 'L', price: 5.0 },
                { size: 20, unit: 'L', price: 15.0 },
                { size: 25, unit: 'Kg', price: 12.5 }
            ];

            for (const pkg of defaultPackages) {
                await dbRun(`
                    INSERT INTO packages (size, unit, price)
                    SELECT ?, ?, ?
                    WHERE NOT EXISTS (
                        SELECT 1 FROM packages WHERE size = ? AND unit = ? AND deleted_at IS NULL
                    )
                `, [pkg.size, pkg.unit, pkg.price, pkg.size, pkg.unit]);
            }
            console.log('Varsayılan ambalaj verileri eklendi');
        }

        // Settings tablosunu oluştur
        await dbRun(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dolar_kuru REAL DEFAULT 0,
                liste_a_kar_orani REAL DEFAULT 20,
                liste_b_kar_orani REAL DEFAULT 35,
                liste_c_kar_orani REAL DEFAULT 50,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // İlk ayarları ekle (eğer yoksa)
        await dbRun(`
            INSERT OR IGNORE INTO settings (id, dolar_kuru, liste_a_kar_orani, liste_b_kar_orani, liste_c_kar_orani)
            VALUES (1, 36.0, 20.0, 35.0, 50.0)
        `);

    } catch (error) {
        console.error('Veritabanı başlatma hatası:', error);
        throw error;
    }
};

// Veritabanını başlat
initializeDatabase().catch(err => {
    logger.error('Database initialization failed:', err);
    process.exit(1);
});

// Önbellek yönetimi
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 dakika

function withCache(key, getData) {
    return async (req, res, next) => {
        try {
            const cached = cache.get(key);
            if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
                return res.json(cached.data);
            }
            
            const data = await getData();
            cache.set(key, {
                data,
                timestamp: Date.now()
            });
            
            res.json(data);
        } catch (error) {
            next(error);
        }
    };
}

// API Endpoint'leri

// Müşteriler
app.get('/api/customers', async (req, res) => {
    try {
        const searchTerm = req.query.search || '';
        const type = req.query.type || '';
        
        let query = 'SELECT * FROM customers WHERE 1=1';
        const params = [];
        
        if (searchTerm) {
            query += ' AND LOWER(name) LIKE LOWER(?)';
            params.push(`%${searchTerm}%`);
        }
        
        if (type && type !== 'Tümü') {
            query += ' AND type = ?';
            params.push(type);
        }
        
        query += ' ORDER BY id DESC';
        
        const customers = await dbAll(query, params);
        res.json(customers);
    } catch (error) {
        console.error('Müşteri listesi alınamadı:', error);
        res.status(500).json({ error: 'Müşteri listesi alınamadı' });
    }
});

app.get('/api/customers/:id', (req, res) => {
    db.get('SELECT * FROM customers WHERE id = ?', [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Müşteri bulunamadı' });
            return;
        }
        res.json(row);
    });
});

// Stok
app.get('/api/stock', async (req, res) => {
    try {
        const stocks = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    id, name, code, quantity, unit, category, price, min_quantity,
                    datetime(created_at, 'localtime') as created_at
                FROM stock 
                WHERE deleted_at IS NULL
                ORDER BY created_at DESC
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        res.json(stocks);
    } catch (error) {
        console.error('Stok listesi getirme hatası:', error);
        res.status(500).json({ error: 'Stok listesi alınırken bir hata oluştu' });
    }
});

app.get('/api/stock/:id', (req, res) => {
    db.get('SELECT * FROM stock WHERE id = ?', [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Ürün bulunamadı' });
            return;
        }
        res.json(row);
    });
});

// Stok sayısını kontrol et
app.get('/api/stock/count', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM stock', [], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(row);
    });
});

// Reçete maliyetlerini güncelleme fonksiyonu
const updateRecipeCosts = async () => {
    try {
        await dbRun('BEGIN TRANSACTION');

        // Tüm reçeteleri al
        const recipes = await dbAll('SELECT * FROM recipes');
        let updatedCount = 0;
        
        // Her reçete için
        for (const recipe of recipes) {
            try {
                // Reçetenin maliyetlerini hesapla
                const ingredients = await dbAll('SELECT * FROM recipe_ingredients WHERE recipe_id = ?', [recipe.id]);
                let totalCost = 0;
                
                for (const ingredient of ingredients) {
                    totalCost += ingredient.quantity * ingredient.price;
                }
                
                // Reçeteyi güncelle
                await dbRun('UPDATE recipes SET total_cost = ? WHERE id = ?', [totalCost, recipe.id]);
                updatedCount++;
            } catch (error) {
                console.error(`Reçete ${recipe.id} güncellenirken hata:`, error);
                continue;
            }
        }
        
        await dbRun('COMMIT');
        return { success: true, updatedCount };
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Reçete maliyetleri güncellenirken hata:', error);
        throw new Error('Reçete fiyatları güncellenemedi: ' + error.message);
    }
};

// Reçete fiyatları güncelleme endpoint'i
app.post('/api/recipes/update-prices', async (req, res) => {
    try {
        await dbRun('BEGIN TRANSACTION');

        // Hammadde fiyatı değişen reçeteleri bul
        const rawMaterialChanges = await dbGet(`
            SELECT COUNT(DISTINCT r.id) as count
            FROM recipes r
            JOIN recipe_ingredients ri ON r.id = ri.recipe_id
            JOIN stock s ON ri.stock_id = s.id
            WHERE r.is_price_updated = false
        `);

        // Ambalaj fiyatı değişen reçeteleri bul
        const packageChanges = await dbGet(`
            SELECT COUNT(DISTINCT r.id) as count
            FROM recipes r
            JOIN recipe_packages rp ON r.id = rp.recipe_id
            JOIN packages p ON rp.package_id = p.id
            WHERE r.is_price_updated = false
        `);

        // Reçeteleri güncelle
        await dbRun(`
            UPDATE recipes 
            SET is_price_updated = true, 
                last_price_update = CURRENT_TIMESTAMP
            WHERE is_price_updated = false
        `);

        await dbRun('COMMIT');

        res.json({
            success: true,
            message: 'Fiyatlar başarıyla güncellendi',
            updatedCount: rawMaterialChanges.count + packageChanges.count,
            rawMaterialChanges: rawMaterialChanges.count,
            packageChanges: packageChanges.count
        });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Fiyat güncelleme hatası:', error);
        res.status(500).json({ error: 'Fiyatlar güncellenirken bir hata oluştu' });
    }
});

// Toplu stok ekleme endpoint'i
app.post('/api/stock/bulk', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenmedi' });
    }

    try {
        // Excel dosyasını oku
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const stocks = xlsx.utils.sheet_to_json(worksheet);

        if (!Array.isArray(stocks) || stocks.length === 0) {
            fs.unlinkSync(req.file.path); // Geçici dosyayı sil
            return res.status(400).json({ error: 'Geçerli stok verisi bulunamadı' });
        }

        // Önce mükerrer kayıtları kontrol et
        const duplicateNames = [];
        const nameCount = {};
        stocks.forEach(stock => {
            if (stock.urun_adi) {
                const lowerName = stock.urun_adi.toLowerCase();
                nameCount[lowerName] = (nameCount[lowerName] || 0) + 1;
                if (nameCount[lowerName] > 1) {
                    duplicateNames.push(stock.urun_adi);
                }
            }
        });

        // Excel içinde mükerrer kayıt varsa işlemi iptal et
        if (duplicateNames.length > 0) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                error: 'Excel içinde mükerrer kayıtlar tespit edildi', 
                duplicates: [...new Set(duplicateNames)].map(name => 
                    `"${name}" ${nameCount[name.toLowerCase()]} defa tekrar ediyor`
                )
            });
        }

        // Veritabanında mevcut olan ürünleri kontrol et
        const existingProducts = await Promise.all(
            stocks.map(stock => 
                dbGet('SELECT name FROM stock WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL', 
                    [stock.urun_adi])
            )
        );

        const existingNames = existingProducts
            .filter(Boolean)
            .map(p => p.name);

        if (existingNames.length > 0) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                error: 'Bazı ürünler zaten mevcut', 
                duplicates: existingNames.map(name => `"${name}"`)
            });
        }

        await dbRun('BEGIN TRANSACTION');

        let successCount = 0;
        let errorCount = 0;

        for (const stock of stocks) {
            try {
                // Excel'den gelen alan adlarını kontrol et
                const name = stock.urun_adi;
                if (!name) {
                    console.error('Ürün adı boş olamaz:', stock);
                    errorCount++;
                    continue;
                }

                // Diğer alanları Excel'den al veya varsayılan değer kullan
                const quantity = parseFloat(stock.miktar) || 0;
                const unit = (stock.birim || 'kg').toUpperCase();
                const price = parseFloat(stock.fiyat) || 0;
                const category = (stock.stok_turu || 'hammadde').toLowerCase();
                const min_quantity = parseFloat(stock.kritik_stok_miktari) || 0;

                // Yeni ürün ekle
                await dbRun(`
                    INSERT INTO stock (
                        name, quantity, unit, category, price, min_quantity
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `, [name, quantity, unit, category, price, min_quantity]);
                successCount++;
            } catch (err) {
                console.error('Stok işlem hatası:', err);
                errorCount++;
            }
        }

        await dbRun('COMMIT');
        
        // Geçici dosyayı sil
        fs.unlinkSync(req.file.path);
        
        res.json({ 
            message: 'İşlem tamamlandı',
            details: {
                added: successCount,
                errors: errorCount
            }
        });
    } catch (err) {
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        await dbRun('ROLLBACK');
        console.error('Excel işleme hatası:', err);
        res.status(500).json({ error: 'Excel dosyası işlenirken bir hata oluştu' });
    }
});

// Reçete API'leri
app.get('/api/recipes', async (req, res) => {
    try {
        const recipes = await dbAll(`
            SELECT r.*, 
                   GROUP_CONCAT(DISTINCT rp.package_id) as packages,
                   r.total_cost,
                   r.density,
                   r.customer_id,
                   c.name as customer_name
            FROM recipes r
            LEFT JOIN customers c ON r.customer_id = c.id
            LEFT JOIN recipe_packages rp ON r.id = rp.recipe_id
            WHERE r.deleted_at IS NULL
            GROUP BY r.id
            ORDER BY r.created_at DESC
        `);

        // Debug için log ekleyelim
        console.log('Loaded recipes:', recipes.length);

        recipes.forEach(recipe => {
            recipe.packages = recipe.packages ? recipe.packages.split(',').map(id => parseInt(id)) : [];
            recipe.total_cost = recipe.total_cost || 0;
        });

        res.json(recipes);
    } catch (error) {
        console.error('Reçete listesi alınamadı:', error);
        res.status(500).json({ error: 'Reçete listesi alınamadı' });
    }
});

// Reçete besin içeriği hesaplama fonksiyonu
async function calculateRecipeNutrients(recipeId) {
    try {
        const ingredients = await dbAll(`
            SELECT ri.quantity, s.*
            FROM recipe_ingredients ri
            JOIN stock s ON ri.stock_id = s.id
            WHERE ri.recipe_id = ? AND s.deleted_at IS NULL
        `, [recipeId]);

        // Toplam miktar hesapla
        const totalQuantity = ingredients.reduce((sum, ing) => sum + ing.quantity, 0);

        // Her besin için toplam içeriği hesapla
        const nutrients = {
            n_content: 0, p_content: 0, k_content: 0, mg_content: 0,
            ca_content: 0, s_content: 0, fe_content: 0, zn_content: 0,
            b_content: 0, mn_content: 0, cu_content: 0, mo_content: 0,
            na_content: 0, si_content: 0, h_content: 0, c_content: 0,
            o_content: 0, cl_content: 0, al_content: 0, organic_content: 0,
            alginic_acid_content: 0, mgo_content: 0, protein_content: 0,
            nem_content: 0, kul_content: 0, ph_content: 0
        };

        // Her hammadde için besin içeriğini hesapla
        ingredients.forEach(ing => {
            const ratio = ing.quantity / totalQuantity;
            Object.keys(nutrients).forEach(nutrient => {
                if (ing[nutrient] !== null && ing[nutrient] !== undefined) {
                    nutrients[nutrient] += (ing[nutrient] * ratio);
                }
            });
        });

        // Sonuçları yuvarlama
        Object.keys(nutrients).forEach(key => {
            nutrients[key] = parseFloat(nutrients[key].toFixed(2));
        });

        return nutrients;
    } catch (error) {
        console.error('Besin içeriği hesaplama hatası:', error);
        throw error;
    }
}

// Reçete detaylarını getir
app.get('/api/recipes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const recipe = await dbGet(`
            SELECT r.*, c.name as customer_name,
                   GROUP_CONCAT(DISTINCT rp.package_id) as packages
            FROM recipes r
            LEFT JOIN customers c ON r.customer_id = c.id
            LEFT JOIN recipe_packages rp ON r.id = rp.recipe_id
            WHERE r.id = ? AND r.deleted_at IS NULL
            GROUP BY r.id
        `, [id]);

        if (!recipe) {
            return res.status(404).json({ error: 'Reçete bulunamadı' });
        }

        // Reçete içeriklerini al
        const ingredients = await dbAll(`
            SELECT ri.*, s.name as stock_name, s.code as stock_code, s.unit
            FROM recipe_ingredients ri
            JOIN stock s ON ri.stock_id = s.id
            WHERE ri.recipe_id = ? AND s.deleted_at IS NULL
        `, [id]);

        // Besin içeriklerini hesapla
        const nutrients = await calculateRecipeNutrients(id);

        recipe.ingredients = ingredients;
        recipe.nutrients = nutrients;
        recipe.packages = recipe.packages ? recipe.packages.split(',').map(id => parseInt(id)) : [];

        res.json(recipe);
    } catch (error) {
        console.error('Reçete detayı alınamadı:', error);
        res.status(500).json({ error: 'Reçete detayı alınamadı' });
    }
});

// Reçete kaydet
app.post('/api/recipes', async (req, res) => {
    const { name, customer_id, density, packages, ingredients } = req.body;

    if (!name || !customer_id || !packages?.length || !ingredients?.length) {
        return res.status(400).json({ error: 'Eksik bilgi' });
    }

    try {
        await dbRun('BEGIN TRANSACTION');

        // Reçeteyi ekle
        const result = await dbRun(`
            INSERT INTO recipes (name, customer_id, density)
            VALUES (?, ?, ?)
        `, [name, customer_id, density]);

        const recipeId = result.lastID;

        // Ambalajları ekle
        for (const packageId of packages) {
            await dbRun(`
                INSERT INTO recipe_packages (recipe_id, package_id)
                VALUES (?, ?)
            `, [recipeId, packageId]);
        }

        // Hammaddeleri ekle
        for (const ingredient of ingredients) {
            await dbRun(`
                INSERT INTO recipe_ingredients (recipe_id, stock_id, name, quantity, price, total)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                recipeId,
                ingredient.stock_id,
                ingredient.name,
                ingredient.quantity,
                ingredient.price,
                ingredient.total
            ]);
        }

        await dbRun('COMMIT');
        res.json({ id: recipeId });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Reçete kaydedilemedi:', error);
        res.status(500).json({ error: 'Reçete kaydedilemedi' });
    }
});

// Reçete güncelle
app.put('/api/recipes/:id', async (req, res) => {
    const { id } = req.params;
    const { name, customer_id, density, packages, ingredients } = req.body;

    if (!name || !customer_id || !packages?.length || !ingredients?.length) {
        return res.status(400).json({ error: 'Eksik bilgi' });
    }

    try {
        await dbRun('BEGIN TRANSACTION');

        // Reçeteyi güncelle
        await dbRun(`
            UPDATE recipes 
            SET name = ?, customer_id = ?, density = ?
            WHERE id = ? AND deleted_at IS NULL
        `, [name, customer_id, density, id]);

        // Mevcut ambalajları sil
        await dbRun('DELETE FROM recipe_packages WHERE recipe_id = ?', [id]);

        // Yeni ambalajları ekle
        for (const packageId of packages) {
            await dbRun(`
                INSERT INTO recipe_packages (recipe_id, package_id)
                VALUES (?, ?)
            `, [id, packageId]);
        }

        // Mevcut içerikleri sil
        await dbRun('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [id]);

        // Yeni içerikleri ekle
        for (const ingredient of ingredients) {
            await dbRun(`
                INSERT INTO recipe_ingredients (recipe_id, stock_id, name, quantity, price, total)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                id,
                ingredient.stock_id,
                ingredient.name,
                ingredient.quantity,
                ingredient.price,
                ingredient.total
            ]);
        }

        await dbRun('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Reçete güncellenemedi:', error);
        res.status(500).json({ error: 'Reçete güncellenemedi' });
    }
});

// Reçete kopyalama endpoint'i
app.post('/api/recipes/:id/copy', async (req, res) => {
    const { id } = req.params;
    
    try {
        await dbRun('BEGIN TRANSACTION');

        // Orijinal reçeteyi al
        const recipe = await dbGet('SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL', [id]);
        if (!recipe) {
            return res.status(404).json({ error: 'Reçete bulunamadı' });
        }

        // Reçete içeriklerini al
        const ingredients = await dbAll('SELECT * FROM recipe_ingredients WHERE recipe_id = ?', [id]);
        const packages = await dbAll('SELECT package_id FROM recipe_packages WHERE recipe_id = ?', [id]);

        // Yeni reçeteyi oluştur
        const result = await dbRun(
            'INSERT INTO recipes (name, customer_id, density) VALUES (?, ?, ?)',
            [`${recipe.name} (Kopya)`, recipe.customer_id, recipe.density]
        );
        const newRecipeId = result.lastID;

        // İçerikleri kopyala
        for (const ingredient of ingredients) {
            await dbRun(
                'INSERT INTO recipe_ingredients (recipe_id, stock_id, name, quantity, price, total) VALUES (?, ?, ?, ?, ?, ?)',
                [newRecipeId, ingredient.stock_id, ingredient.name, ingredient.quantity, ingredient.price, ingredient.total]
            );
        }

        // Ambalajları kopyala
        for (const pkg of packages) {
            await dbRun(
                'INSERT INTO recipe_packages (recipe_id, package_id) VALUES (?, ?)',
                [newRecipeId, pkg.package_id]
            );
        }

        await dbRun('COMMIT');
        res.json({ success: true, message: 'Reçete başarıyla kopyalandı', newRecipeId });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Reçete kopyalama hatası:', error);
        res.status(500).json({ error: 'Reçete kopyalanırken bir hata oluştu' });
    }
});

// Siparişler
app.get('/api/orders', (req, res) => {
    db.all('SELECT * FROM orders ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/orders/:id', (req, res) => {
    db.get('SELECT * FROM orders WHERE id = ?', [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Sipariş bulunamadı' });
            return;
        }
        res.json(row);
    });
});

// Sipariş silme endpoint'i
app.delete('/api/orders/:id', async (req, res) => {
    try {
        const result = await dbRun('DELETE FROM orders WHERE id = ?', [req.params.id]);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Sipariş bulunamadı' });
        }
        
        res.json({ message: 'Sipariş başarıyla silindi' });
    } catch (error) {
        console.error('Sipariş silme hatası:', error);
        res.status(500).json({ error: 'Sipariş silinirken bir hata oluştu' });
    }
});

// Sipariş durumu güncelleme endpoint'i
app.put('/api/orders/:id/status', async (req, res) => {
    const { status } = req.body;
    
    if (!status || !['Beklemede', 'Onaylandı', 'İptal'].includes(status)) {
        return res.status(400).json({ error: 'Geçersiz sipariş durumu' });
    }
    
    try {
        const result = await dbRun(
            'UPDATE orders SET status = ? WHERE id = ?',
            [status, req.params.id]
        );
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Sipariş bulunamadı' });
        }
        
        res.json({ message: 'Sipariş durumu güncellendi' });
    } catch (error) {
        console.error('Sipariş durumu güncelleme hatası:', error);
        res.status(500).json({ error: 'Sipariş durumu güncellenirken bir hata oluştu' });
    }
});

// Stok verilerini detaylı kontrol et
app.get('/api/stock/debug/all', (req, res) => {
    db.all(`
        SELECT 
            id, code, name, quantity, unit, category, price,
            datetime(created_at, 'localtime') as created_at
        FROM stock 
        ORDER BY created_at DESC
    `, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({
            count: rows.length,
            records: rows
        });
    });
});

// Stok güncelleme endpoint'i
app.put('/api/stock/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        name, quantity, unit, category, price, min_quantity
    } = req.body;
    
    if (!name) {
        res.status(400).json({ error: 'Ürün adı zorunludur' });
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE stock 
                SET name = ?,
                    quantity = ?,
                    unit = ?,
                    category = ?,
                    price = ?,
                    min_quantity = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [
                name,
                quantity,
                unit,
                category,
                price,
                min_quantity,
                id
            ], function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        const updatedStock = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM stock WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        res.json(updatedStock);
    } catch (error) {
        console.error('Stok güncelleme hatası:', error);
        res.status(500).json({ error: 'Stok güncellenirken bir hata oluştu' });
    }
});

// Stok silme endpoint'i
app.delete('/api/stock/:id', async (req, res) => {
    try {
        await dbRun(`
            UPDATE stock 
            SET deleted_at = datetime('now') 
            WHERE id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        res.json({ message: 'Stok başarıyla silindi' });
    } catch (err) {
        console.error('Stok silme hatası:', err);
        res.status(500).json({ error: 'Stok silinirken bir hata oluştu' });
    }
});

// Cari işlemleri
app.post('/api/customers', async (req, res) => {
    const { name, type, email, phone, address } = req.body;
    
    if (!name || !type) {
        return res.status(400).json({ error: 'Cari adı ve türü zorunludur' });
    }

    if (!['Müşteri', 'Tedarikçi', 'Fason', 'Diğer', 'Bioplant'].includes(type)) {
        return res.status(400).json({ error: 'Geçersiz cari türü' });
    }

    try {
        // Aynı isimde cari var mı kontrol et (büyük/küçük harf duyarsız)
        const existingCustomer = await dbGet(
            'SELECT * FROM customers WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL',
            [name]
        );

        if (existingCustomer) {
            return res.status(400).json({ 
                error: `"${existingCustomer.name}" adında bir cari zaten mevcut` 
            });
        }

        const result = await dbRun(`
            INSERT INTO customers (name, type, email, phone, address, balance)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [name, type, email || null, phone || null, address || null, 0]);

        // Yeni eklenen müşteriyi getir
        const newCustomer = await dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);

        res.json({ 
            message: 'Cari başarıyla eklendi',
            customer: newCustomer
        });
    } catch (err) {
        console.error('Cari eklenirken hata:', err);
        res.status(500).json({ error: 'Cari eklenirken bir hata oluştu' });
    }
});

app.put('/api/customers/:id', async (req, res) => {
    const { name, type, email, phone, address } = req.body;
    
    if (!name || !type) {
        res.status(400).json({ error: 'Cari adı ve türü zorunludur' });
        return;
    }

    if (!['Müşteri', 'Tedarikçi'].includes(type)) {
        res.status(400).json({ error: 'Geçersiz cari türü' });
        return;
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE customers 
                SET name = ?, type = ?, email = ?, phone = ?, address = ?
                WHERE id = ?
            `, [name, type, email || null, phone || null, address || null, req.params.id], 
            function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        res.json({ message: 'Cari başarıyla güncellendi' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        await dbRun(`
            UPDATE customers 
            SET deleted_at = datetime('now') 
            WHERE id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        res.json({ message: 'Cari başarıyla silindi' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/customers/bulk', async (req, res) => {
    const { customers } = req.body;
    if (!Array.isArray(customers) || customers.length === 0) {
        res.status(400).json({ error: 'Geçerli cari verisi gönderilmedi' });
        return;
    }

    const runAsync = (sql, params) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

    try {
        await runAsync('BEGIN TRANSACTION');

        let successCount = 0;
        let updateCount = 0;
        let errorCount = 0;
        let duplicateNames = [];

        // Önce mükerrer kayıtları kontrol et (büyük/küçük harf duyarsız)
        const existingCustomers = await new Promise((resolve, reject) => {
            const names = customers.map(c => c.name?.toLowerCase()).filter(Boolean);
            if (names.length === 0) {
                resolve([]);
                return;
            }
            
            const placeholders = names.map(() => 'LOWER(name) = ?').join(' OR ');
            db.all(
                `SELECT name FROM customers WHERE ${placeholders}`,
                names,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });

        if (existingCustomers.length > 0) {
            await runAsync('ROLLBACK');
            return res.status(400).json({ 
                error: 'Bazı cariler zaten mevcut', 
                duplicates: existingCustomers.map(c => `"${c.name}"`)
            });
        }

        // Liste içinde tekrar eden isimleri kontrol et
        const nameCount = {};
        customers.forEach(customer => {
            if (customer.name) {
                const lowerName = customer.name.toLowerCase();
                nameCount[lowerName] = (nameCount[lowerName] || 0) + 1;
                if (nameCount[lowerName] > 1) {
                    duplicateNames.push(customer.name);
                }
            }
        });

        // Eğer liste içinde mükerrer kayıt varsa işlemi iptal et
        if (duplicateNames.length > 0) {
            await runAsync('ROLLBACK');
            return res.status(400).json({ 
                error: 'Liste içinde mükerrer kayıtlar tespit edildi', 
                duplicates: [...new Set(duplicateNames)].map(name => 
                    `"${name}" ${nameCount[name.toLowerCase()]} defa tekrar ediyor`
                )
            });
        }

        for (const customer of customers) {
            try {
                if (!customer.name || !customer.type) {
                    console.error('Cari adı ve türü zorunludur:', customer);
                    errorCount++;
                    continue;
                }

                if (!['Müşteri', 'Tedarikçi'].includes(customer.type)) {
                    console.error('Geçersiz cari türü:', customer);
                    errorCount++;
                    continue;
                }

                // Yeni cari ekle
                await runAsync(`
                    INSERT INTO customers (
                        name, type, email, phone, address, balance
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    customer.name,
                    customer.type,
                    customer.email || null,
                    customer.phone || null,
                    customer.address || null,
                    0
                ]);
                successCount++;
            } catch (err) {
                console.error('Cari işlem hatası:', err);
                errorCount++;
            }
        }

        await runAsync('COMMIT');
        
        res.json({ 
            message: 'İşlem tamamlandı',
            details: {
                added: successCount,
                errors: errorCount
            }
        });
    } catch (err) {
        await runAsync('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// Ambalaj API'leri
app.get('/api/packages', async (req, res) => {
    try {
        const packages = await dbAll('SELECT * FROM packages WHERE deleted_at IS NULL ORDER BY size');
        res.json(packages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/packages', async (req, res) => {
    const { size, unit, price } = req.body;
    
    if (!size || !unit || price === undefined) {
        res.status(400).json({ error: 'Ambalaj boyutu, birimi ve fiyatı zorunludur' });
        return;
    }

    if (!['L', 'Kg'].includes(unit)) {
        res.status(400).json({ error: 'Geçersiz birim. Sadece L veya Kg olabilir' });
        return;
    }

    try {
        // Aynı boyut ve birimde ambalaj var mı kontrol et
        const existingPackage = await dbGet(
            'SELECT * FROM packages WHERE size = ? AND unit = ? AND deleted_at IS NULL',
            [size, unit]
        );

        if (existingPackage) {
            res.status(400).json({ 
                error: `${size} ${unit} ambalaj zaten mevcut` 
            });
            return;
        }

        const result = await dbRun(`
            INSERT INTO packages (size, unit, price)
            VALUES (?, ?, ?)
        `, [size, unit, price]);

        // Yeni eklenen ambalajı getir
        const newPackage = await dbGet('SELECT * FROM packages WHERE id = ?', [result.lastID]);

        res.json({ 
            message: 'Ambalaj başarıyla eklendi',
            package: newPackage
        });
    } catch (error) {
        console.error('Ambalaj eklenirken hata:', error);
        res.status(500).json({ error: 'Ambalaj eklenirken bir hata oluştu' });
    }
});

app.put('/api/packages/:id', async (req, res) => {
    const { size, unit, price } = req.body;
    
    if (!size || !unit || price === undefined) {
        res.status(400).json({ error: 'Ambalaj boyutu, birimi ve fiyatı zorunludur' });
        return;
    }

    if (!['L', 'Kg'].includes(unit)) {
        res.status(400).json({ error: 'Geçersiz birim. Sadece L veya Kg olabilir' });
        return;
    }

    try {
        // Aynı boyut ve birimde başka ambalaj var mı kontrol et
        const existingPackage = await dbGet(
            'SELECT * FROM packages WHERE size = ? AND unit = ? AND id != ? AND deleted_at IS NULL',
            [size, unit, req.params.id]
        );

        if (existingPackage) {
            res.status(400).json({ 
                error: `${size} ${unit} ambalaj zaten mevcut` 
            });
            return;
        }

        await dbRun(`
            UPDATE packages 
            SET size = ?, unit = ?, price = ?
            WHERE id = ? AND deleted_at IS NULL
        `, [size, unit, price, req.params.id]);

        res.json({ message: 'Ambalaj başarıyla güncellendi' });
    } catch (error) {
        console.error('Ambalaj güncellenirken hata:', error);
        res.status(500).json({ error: 'Ambalaj güncellenirken bir hata oluştu' });
    }
});

app.delete('/api/packages/:id', async (req, res) => {
    try {
        await dbRun(`
            UPDATE packages 
            SET deleted_at = datetime('now') 
            WHERE id = ? AND deleted_at IS NULL
        `, [req.params.id]);

        res.json({ message: 'Ambalaj başarıyla silindi' });
    } catch (err) {
        console.error('Ambalaj silme hatası:', err);
        res.status(500).json({ error: 'Ambalaj silinirken bir hata oluştu' });
    }
});

// Yedekleme API'leri
app.post('/api/backup/database', (req, res) => {
    const { backupPath } = req.body;
    if (!backupPath) {
        return res.status(400).json({ error: 'Yedekleme yolu belirtilmedi' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupPath);
    const backupFile = path.join(backupDir, `database_${timestamp}.sqlite`);

    try {
        // Klasör yoksa oluştur
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Veritabanı dosyasını kopyala
        fs.copyFileSync(
            path.join(__dirname, 'database.sqlite'),
            backupFile
        );

        // Dosya boyutunu al
        const stats = fs.statSync(backupFile);

        res.json({ 
            message: 'Veritabanı yedeği oluşturuldu', 
            path: backupFile,
            size: stats.size,
            timestamp: timestamp
        });
    } catch (error) {
        console.error('Yedekleme hatası:', error);
        res.status(500).json({ error: 'Yedekleme sırasında bir hata oluştu' });
    }
});

app.post('/api/backup/full', (req, res) => {
    const { backupPath } = req.body;
    if (!backupPath) {
        return res.status(400).json({ error: 'Yedekleme yolu belirtilmedi' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupPath, `full_${timestamp}`);

    try {
        // Klasör yoksa oluştur
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Tüm proje dosyalarını kopyala
        fs.copyFileSync(
            path.join(__dirname, 'database.sqlite'),
            path.join(backupDir, 'database.sqlite')
        );
        
        // Diğer önemli dosyaları da kopyala
        const filesToBackup = ['schema.sql', 'seed.sql', 'package.json'];
        filesToBackup.forEach(file => {
            if (fs.existsSync(path.join(__dirname, file))) {
                fs.copyFileSync(
                    path.join(__dirname, file),
                    path.join(backupDir, file)
                );
            }
        });

        // Toplam boyutu hesapla
        let totalSize = 0;
        fs.readdirSync(backupDir).forEach(file => {
            const stats = fs.statSync(path.join(backupDir, file));
            totalSize += stats.size;
        });

        res.json({ 
            message: 'Tam yedek oluşturuldu', 
            path: backupDir,
            size: totalSize,
            timestamp: timestamp
        });
    } catch (error) {
        console.error('Yedekleme hatası:', error);
        res.status(500).json({ error: 'Yedekleme sırasında bir hata oluştu' });
    }
});

app.post('/api/backup/restore', (req, res) => {
    const { backupPath } = req.body;
    if (!backupPath) {
        return res.status(400).json({ error: 'Yedekleme yolu belirtilmedi' });
    }

    try {
        // En son yedeği bul
        const backups = fs.readdirSync(backupPath)
            .filter(f => f.startsWith('database_'))
            .sort()
            .reverse();

        if (backups.length === 0) {
            throw new Error('Kullanılabilir yedek bulunamadı');
        }

        const lastBackup = backups[0];
        const backupFile = path.join(backupPath, lastBackup);

        // Mevcut veritabanını yedekle
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const currentBackupPath = path.join(backupPath, `pre_restore_${timestamp}.sqlite`);
        
        fs.copyFileSync(
            path.join(__dirname, 'database.sqlite'),
            currentBackupPath
        );

        // Yedeği geri yükle
        fs.copyFileSync(
            backupFile,
            path.join(__dirname, 'database.sqlite')
        );

        // Dosya boyutunu al
        const stats = fs.statSync(backupFile);

        res.json({ 
            message: 'Yedek başarıyla geri yüklendi',
            path: backupFile,
            size: stats.size,
            timestamp: timestamp
        });
    } catch (error) {
        console.error('Geri yükleme hatası:', error);
        res.status(500).json({ error: 'Geri yükleme sırasında bir hata oluştu' });
    }
});

// Dosyadan geri yükleme endpoint'i
app.post('/api/backup/restore-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenmedi' });
    }

    try {
        // Önce mevcut veritabanını yedekle
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const currentBackupPath = path.join(__dirname, 'backups', `pre_restore_${timestamp}.sqlite`);

        // Yedekleme klasörü yoksa oluştur
        if (!fs.existsSync(path.join(__dirname, 'backups'))) {
            fs.mkdirSync(path.join(__dirname, 'backups'), { recursive: true });
        }

        // Mevcut veritabanını yedekle
        fs.copyFileSync(
            path.join(__dirname, 'database.sqlite'),
            currentBackupPath
        );

        // Yüklenen dosyı veritabanı olarak kullan
        fs.copyFileSync(
            req.file.path,
            path.join(__dirname, 'database.sqlite')
        );

        // Geçici dosyayı sil
        fs.unlinkSync(req.file.path);

        // Dosya boyutunu al
        const stats = fs.statSync(path.join(__dirname, 'database.sqlite'));

        res.json({ 
            message: 'Veritabanı başarıyla geri yüklendi',
            path: req.file.originalname,
            size: stats.size,
            timestamp: timestamp
        });
    } catch (error) {
        console.error('Geri yükleme hatası:', error);
        res.status(500).json({ error: 'Geri yükleme sırasında bir hata oluştu' });
    }
});

// Excel Import/Export Endpoints
app.post('/api/stock/import', upload.single('file'), async (req, res) => {
    try {
        // Excel dosyasını oku ve verileri ekle
        // Excel işlemleri için xlsx veya exceljs kullanılabilir
        res.json({ message: 'Veriler başarıyla içe aktarıldı' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stock/export', async (req, res) => {
    try {
        // Stok verilerini Excel olarak dışa aktar
        res.json({ message: 'Veriler başarıyla dışa aktarıldı' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Hammadde fiyatı güncelleme endpoint'i
app.put('/api/stock/:id/price', async (req, res) => {
    const { id } = req.params;
    const { new_price } = req.body;
    
    try {
        // 1. Eski fiyatı al
        const stock = await dbGet('SELECT price FROM stock WHERE id = ?', [id]);
        
        // 2. Yeni fiyatı güncelle
        await dbRun('UPDATE stock SET price = ? WHERE id = ?', [new_price, id]);
        
        // 3. Bu hammaddeyi kullanan tüm reçeteleri işaretle
        await dbRun(`
            UPDATE recipes SET 
                is_price_updated = false
            WHERE id IN (
                SELECT DISTINCT recipe_id 
                FROM recipe_ingredients 
                WHERE stock_id = ?
            )`, [id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Hammadde fiyat güncelleme hatası:', error);
        res.status(500).json({ error: error.message });
    }
});

// Ambalaj fiyatlarını güncelle
app.post('/api/update-package-prices', async (req, res) => {
    try {
        await dbRun('BEGIN TRANSACTION');

        await dbRun(`UPDATE packages SET price = CASE id
            WHEN 1 THEN 46 -- 1L
            WHEN 2 THEN 75 -- 5L
            WHEN 3 THEN 170 -- 20L
            WHEN 5 THEN 32 -- 1Kg
            WHEN 6 THEN 44 -- 5Kg
            WHEN 7 THEN 2500 -- 1000L
            WHEN 8 THEN 45 -- 25Kg
            WHEN 9 THEN 79 -- 10Kg
            END
            WHERE id IN (1,2,3,5,6,7,8,9)`);

        // Etkilenen reçeteleri güncelle
        await dbRun(`
            UPDATE recipes 
            SET is_price_updated = false,
                last_price_update = datetime('now')
            WHERE id IN (
                SELECT DISTINCT recipe_id 
                FROM recipe_packages 
                WHERE package_id IN (1,2,3,5,6,7,8,9)
            )`);

        await dbRun('COMMIT');
        
        res.json({ success: true, message: 'Ambalaj fiyatları ve reçeteler güncellendi' });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Fiyat güncelleme hatası:', error);
        res.status(500).json({ success: false, message: 'Fiyat güncelleme hatası' });
    }
});

// Fiyat geçmişi endpoint'leri
app.get('/api/stock/:id/price-history', async (req, res) => {
    try {
        const history = await db.all(
            'SELECT * FROM stock_price_history WHERE stock_id = ? ORDER BY update_date DESC',
            [req.params.id]
        );
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/packages/:id/price-history', async (req, res) => {
    try {
        const history = await db.all(
            'SELECT * FROM package_price_history WHERE package_id = ? ORDER BY update_date DESC',
            [req.params.id]
        );
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Settings endpoints
app.get('/api/settings', withCache('settings', async () => {
    return await db.all('SELECT * FROM settings');
}));

app.put('/api/settings', async (req, res) => {
    try {
        const { dolar_kuru, liste_a_kar_orani, liste_b_kar_orani, liste_c_kar_orani } = req.body;
        
        await dbRun(`
            UPDATE settings 
            SET dolar_kuru = ?,
                liste_a_kar_orani = ?,
                liste_b_kar_orani = ?,
                liste_c_kar_orani = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `, [
            dolar_kuru || 0,
            liste_a_kar_orani || 20,
            liste_b_kar_orani || 35,
            liste_c_kar_orani || 50
        ]);

        res.json({ message: 'Ayarlar başarıyla güncellendi' });
    } catch (error) {
        console.error('Ayarlar güncellenirken hata:', error);
        res.status(500).json({ error: 'Ayarlar güncellenemedi' });
    }
});

// Fiyat güncellemelerini kontrol et
app.get('/api/recipes/check-price-updates', async (req, res) => {
    try {
        const sql = `
            SELECT DISTINCT r.* 
            FROM recipes r
            LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
            LEFT JOIN stock s ON ri.stock_id = s.id
            LEFT JOIN packages p ON p.id IN (
                SELECT CAST(value AS INTEGER) 
                FROM json_each(r.packages)
            )
            WHERE r.deleted_at IS NULL 
            AND (
                r.is_price_updated = 0 
                OR r.is_price_updated IS NULL 
                OR s.updated_at > r.updated_at 
                OR p.updated_at > r.updated_at
            )
        `;
        
        const recipes = await dbAll(sql);
        logger.info(`Found ${recipes.length} recipes requiring price updates`);
        res.json(recipes);
    } catch (error) {
        logger.error('Error checking recipe price updates:', error);
        res.status(500).json({ error: 'Reçete fiyat kontrolü yapılırken bir hata oluştu' });
    }
});

// Reçete fiyatları güncelleme endpoint'i
app.post('/api/recipes/update-prices', async (req, res) => {
    try {
        await dbRun('BEGIN TRANSACTION');

        // Tüm reçetelerin maliyetlerini güncelle
        const recipes = await dbAll(`
            SELECT id FROM recipes WHERE deleted_at IS NULL
        `);

        let updatedCount = 0;

        for (const recipe of recipes) {
            // Her reçetenin maliyetini hesapla
            const ingredients = await dbAll(`
                SELECT 
                    ri.quantity,
                    s.price
                FROM recipe_ingredients ri
                JOIN stock s ON ri.stock_id = s.id
                WHERE ri.recipe_id = ?
            `, [recipe.id]);

            const totalCost = ingredients.reduce((sum, ing) => {
                return sum + (ing.quantity * ing.price);
            }, 0);

            // Reçete maliyetini güncelle
            await dbRun(`
                UPDATE recipes 
                SET total_cost = ?,
                    is_price_updated = 1,
                    last_price_update = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [totalCost, recipe.id]);

            updatedCount++;
        }

        await dbRun('COMMIT');

        res.json({ 
            message: 'Reçete fiyatları güncellendi',
            updatedCount
        });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Fiyat güncelleme hatası:', error);
        res.status(500).json({ error: 'Fiyatlar güncellenirken bir hata oluştu' });
    }
});

// Sipariş oluşturma endpoint'i
app.post('/api/orders', async (req, res) => {
    const { customer_id, recipe_id, quantity, total, status } = req.body;

    if (!customer_id || !recipe_id || !quantity) {
        return res.status(400).json({ error: 'Eksik bilgi' });
    }

    try {
        // Önce reçetenin ve müşterinin var olduğunu kontrol et
        const recipe = await dbGet('SELECT id FROM recipes WHERE id = ? AND deleted_at IS NULL', [recipe_id]);
        if (!recipe) {
            return res.status(404).json({ error: 'Reçete bulunamadı' });
        }

        const customer = await dbGet('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', [customer_id]);
        if (!customer) {
            return res.status(404).json({ error: 'Müşteri bulunamadı' });
        }

        // Siparişi kaydet
        const result = await dbRun(`
            INSERT INTO orders (
                customer_id, 
                recipe_id, 
                quantity,
                total,
                status
            ) VALUES (?, ?, ?, ?, ?)
        `, [
            customer_id, 
            recipe_id, 
            quantity,
            total || 0,
            status || 'Beklemede'
        ]);

        res.json({
            success: true, 
            message: 'Sipariş başarıyla oluşturuldu',
            orderId: result.lastID 
        });
    } catch (error) {
        console.error('Sipariş oluşturma hatası:', error);
        res.status(500).json({ 
            error: 'Sipariş oluşturulurken bir hata oluştu',
            details: error.message
        });
    }
});

// Aktif siparişleri getir
app.get('/api/active-orders', async (req, res) => {
    try {
        const orders = await dbAll(`
            SELECT o.*, c.name as customer_name, r.name as recipe_name 
            FROM orders o
            LEFT JOIN customers c ON o.customer_id = c.id
            LEFT JOIN recipes r ON o.recipe_id = r.id
            WHERE o.status = 'Beklemede'
            ORDER BY o.created_at DESC
        `);
        res.json(orders);
    } catch (error) {
        console.error('Aktif sipariş listesi alınamadı:', error);
        res.status(500).json({ error: 'Aktif sipariş listesi alınamadı' });
    }
});

// PDF teklif oluşturma endpoint'i
app.post('/api/teklif/create-pdf', async (req, res) => {
    const { musteriAdi, paraBirimi, urunler, tarih } = req.body;

    if (!musteriAdi || !urunler || urunler.length === 0) {
        return res.status(400).json({ error: 'Geçersiz teklif bilgileri' });
    }

    try {
        // Teklif ayarlarını al
        const teklifSettings = await dbGet('SELECT * FROM teklif_settings ORDER BY id DESC LIMIT 1');
        if (!teklifSettings) {
            throw new Error('Teklif ayarları bulunamadı');
        }

        // PDF oluştur
        createTeklifPDF({
            musteriAdi,
            paraBirimi,
            urunler,
            tarih,
            teklifSettings
        }, res);

    } catch (error) {
        console.error('PDF oluşturma hatası:', error);
        res.status(500).json({ error: 'PDF oluşturulurken bir hata oluştu: ' + error.message });
    }
});

// Teklif ayarlarını getir
app.get('/api/teklif-settings', async (req, res) => {
    try {
        const settings = await dbGet('SELECT * FROM teklif_settings ORDER BY id DESC LIMIT 1');
        if (!settings) {
            res.status(404).json({ error: 'Teklif ayarları bulunamadı' });
            return;
        }
        res.json(settings);
    } catch (error) {
        console.error('Teklif ayarları alınırken hata:', error);
        res.status(500).json({ error: 'Teklif ayarları alınamadı' });
    }
});

// Teklif ayarlarını güncelle
app.put('/api/teklif-settings/:id', async (req, res) => {
    const { id } = req.params;
    const {
        firma_adi,
        firma_adresi,
        firma_telefon,
        firma_email,
        firma_web,
        firma_vergi_dairesi,
        firma_vergi_no,
        banka_bilgileri,
        teklif_notu,
        teklif_gecerlilik,
        teklif_sartlari,
        teklif_alt_not
    } = req.body;

    try {
        await dbRun(`
            UPDATE teklif_settings 
            SET firma_adi = ?,
                firma_adresi = ?,
                firma_telefon = ?,
                firma_email = ?,
                firma_web = ?,
                firma_vergi_dairesi = ?,
                firma_vergi_no = ?,
                banka_bilgileri = ?,
                teklif_notu = ?,
                teklif_gecerlilik = ?,
                teklif_sartlari = ?,
                teklif_alt_not = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            firma_adi,
            firma_adresi,
            firma_telefon,
            firma_email,
            firma_web,
            firma_vergi_dairesi,
            firma_vergi_no,
            banka_bilgileri,
            teklif_notu,
            teklif_gecerlilik,
            teklif_sartlari,
            teklif_alt_not,
            id
        ]);

        res.json({ message: 'Teklif ayarları güncellendi' });
    } catch (error) {
        console.error('Teklif ayarları güncellenirken hata:', error);
        res.status(500).json({ error: 'Teklif ayarları güncellenemedi' });
    }
});

// Sunucuyu başlat
app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
}); 

// Yeni stok ekleme endpoint'i
app.post('/api/stock', async (req, res) => {
    const { 
        name, quantity, unit, category, price, min_quantity
    } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Ürün adı zorunludur' });
    }

    try {
        const result = await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO stock (
                    name, quantity, unit, category, price, min_quantity
                ) VALUES (?, ?, ?, ?, ?, ?)
            `, [
                name,
                quantity || 0,
                unit || 'kg',
                category || 'hammadde',
                price || 0,
                min_quantity || 0
            ], function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        // Yeni eklenen stok verisini getir
        const newStock = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM stock WHERE id = ?', [result.lastID], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        res.status(201).json(newStock);
    } catch (error) {
        console.error('Stok ekleme hatası:', error);
        res.status(500).json({ error: 'Stok eklenirken bir hata oluştu' });
    }
});

// Reçete silme endpoint'i
app.delete('/api/recipes/:id', async (req, res) => {
    const { id } = req.params;
    console.log('Deleting recipe:', id); // Debug log
    
    try {
        await dbRun('BEGIN TRANSACTION');

        // Önce reçetenin var olduğunu kontrol et
        const recipe = await dbGet('SELECT * FROM recipes WHERE id = ?', [id]);
        console.log('Found recipe:', recipe); // Debug log

        if (!recipe) {
            await dbRun('ROLLBACK');
            return res.status(404).json({ error: 'Reçete bulunamadı' });
        }

        // Reçeteyi soft delete yap
        await dbRun('UPDATE recipes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);

        // İlişkili kayıtları temizle
        await dbRun('DELETE FROM recipe_packages WHERE recipe_id = ?', [id]);
        await dbRun('DELETE FROM recipe_ingredients WHERE recipe_id = ?', [id]);

        await dbRun('COMMIT');
        res.json({ success: true });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error('Reçete silinemedi:', error);
        res.status(500).json({ error: 'Reçete silinemedi' });
    }
});

// Reçete fiyat güncelleme kontrolü endpoint'i
app.get('/api/recipes/check-price-updates', async (req, res) => {
    try {
        const sql = `
            SELECT DISTINCT r.* 
            FROM recipes r
            LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
            LEFT JOIN stock s ON ri.stock_id = s.id
            WHERE r.deleted_at IS NULL 
            AND (r.is_price_updated = 0 OR r.is_price_updated IS NULL)
        `;
        
        const recipes = await dbAll(sql);
        logger.info(`Fiyat güncellemesi gereken ${recipes.length} reçete bulundu`);
        res.json(recipes);
    } catch (error) {
        logger.error('Reçete fiyat kontrolü hatası:', error);
        res.status(500).json({ error: 'Reçete fiyat kontrolü yapılırken bir hata oluştu' });
    }
});