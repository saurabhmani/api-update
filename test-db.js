const mysql = require("mysql2/promise");

async function testDB() {
  try {
    const connection = await mysql.createConnection({
      host: "127.0.0.1",
      user: "devapps",
      password: "YsOG*fSa#0Tm",
      database: "quantorus365",
    });

    console.log("✅ Connected to MySQL");

    // Test query
    const [rows] = await connection.execute("SELECT 1 + 1 AS result");

    console.log("✅ Query Result:", rows);

    await connection.end();
    console.log("✅ Connection closed");
  } catch (error) {
    console.error("❌ DB Connection Failed:");
    console.error(error.message);
  }
}

testDB();
