import pkg from "pg";
const { Pool } = pkg;

// 读取环境变量
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("请设置 DATABASE_URL 环境变量");
  process.exit(1);
}

// 初始化数据库连接池
const pool = new Pool({ connectionString: DATABASE_URL });

async function initDB() {
  const client = await pool.connect();
  try {
    // 创建 users 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 创建 threads 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        topic_id BIGINT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id)
      );
    `);

    // 创建 messages 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT,
        type TEXT NOT NULL DEFAULT 'text',
        file_id TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (thread_id) REFERENCES threads(id)
      );
    `);

    console.log("✅ 数据库初始化完成！");
  } catch (err) {
    console.error("❌ 数据库初始化失败：", err);
  } finally {
    client.release();
    pool.end();
  }
}

// 执行初始化
initDB();
