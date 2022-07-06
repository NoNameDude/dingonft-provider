"use strict";

const DEBUG = false;
const debug = (x) => {
  if (DEBUG) {
    console.log(x);
  }
};

const pg = require('pg');

let db = null;

module.exports = {
  load,
  beginTransaction,
  endTransaction,

  addAsset,
  hasAsset,
  getAsset,

  getLastTransactionHeight,
  getTransactions,
  getFirstTransaction,
  getLastTransaction,
  addTransaction,

  getAssetNonce,

  getProfile,
  setProfile,
  getProfileCreatedAssets,
  getProfileOwnedAssets,
  getProfileHistoricalAssets,
  isProfileHistoricalAsset,
  getProfileCreatedCount,
  getProfileCollectionCount,
  getProfileHistoricalCount,
  queryProfileBySearch,
  queryProfileByTradeCount,
  queryProfileByEarnings,

  getCollection,
  getCollections,
  queryUnassignedNftsByOwner,
  queryCollectionByOwner,
  queryCollectionBySearch,
  setCollection,
  setCollectionItem,
  getCollectionItems,
  getCollectionStats,
  getItemCollection,

  getNftStats,
  setNftStats,
  getProfileStats,
  setProfileStats,

  queryNft,
  queryNftBySearch,
  queryNftByNewest,
  queryCollectionByScaled,
  queryCollectionByValuable,

  getPlatformStats
};

async function load() {
  db = new pg.Client('postgres://dingo:dingopassword@localhost:5432/dingo');
  await db.connect();
}

function beginTransaction() {
  return db.query(`BEGIN TRANSACTION`);
}

function endTransaction() {
  return db.query(`END TRANSACTION`);
}

function addAsset(asset) {
  debug('addAsset');

  return db.query(
    `INSERT INTO assets (contentHash, address, name, tags, description) VALUES ($1, $2, $3, $4, $5)`,
    [asset.contentHash, asset.address, asset.name, asset.tags, asset.description]
  );
}

async function hasAsset(address) {
  debug('hasAsset');

  return parseInt((
    (
      await db.query(
        `SELECT COUNT(*) from assets WHERE address=$1`,
        [address]
      )
    ).rows[0].count) > 0
  );
}

async function getAsset(address) {
  debug('getAsset');

  const results = await db.query(
    `SELECT contentHash as "contentHash", address, name, tags, description FROM assets WHERE address=$1 LIMIT 1`,
    [address]
  );
  if (results.rows.length === 0) {
    return null;
  }
  return results.rows[0];
}

async function getLastTransactionHeight(address) {
  debug('getLastTransactionHeight');

  return (
    await db.query(
      `SELECT MAX(height) from transactions`
    )
  ).rows[0].max;
}

async function getTransactions(address) {
  debug('getTransactions');

  return (await db.query(
    `SELECT address, owner, txid, height FROM transactions WHERE address=$1 ORDER BY id ASC`,
    [address]
  )).rows;
}

async function getFirstTransaction(address) {
  debug('getFirstTransaction');

  const results = await db.query(
    `SELECT address, owner, txid, height FROM transactions WHERE address=$1 ORDER BY id ASC LIMIT 1`,
    [address]
  );
  if (results.rows.length === 0) {
    return null;
  }
  return results.rows[0];
}

async function getLastTransaction(address) {  
  debug('getLastTransaction');

  const results = await db.query(
    `SELECT address, owner, txid, height FROM transactions WHERE address=$1 ORDER BY id DESC LIMIT 1`,
    [address]
  );
  if (results.rows.length === 0) {
    return null;
  }
  return results.rows[0];
}

function addTransaction(tx) {
  debug('addTransaction');

  return db.query(
    `INSERT INTO transactions (address, owner, txid, height) VALUES ($1, $2, $3, $4)`,
    [tx.address, tx.owner, tx.txid, tx.height]
  );
}

async function getAssetNonce(address) {
  debug('getAssetNonce');

  return parseInt((
    await db.query(
      `SELECT COUNT(*) from transactions WHERE address=$1`,
      [address]
    )
  ).rows[0].count);
}

async function getProfileCreatedAssets(owner) {
  debug('getProfileCreatedAssets');

  return (await db.query(
    "SELECT address FROM nftStats WHERE creator=$1 ORDER BY id ASC",
    [owner]
  )).rows.map((x) => x.address);
}

async function getProfileOwnedAssets(owner) {
  debug('getProfileOwnedAssets');

  return (await db.query(
    "SELECT address FROM nftStats WHERE owner=$1 ORDER BY id ASC",
    [owner]
  )).rows.map((x) => x.address);
}

async function getProfileHistoricalAssets(owner) {
  debug('getProfileHistoricalAssets');

  return (await db.query(
    `SELECT address FROM (SELECT address, ROW_NUMBER() OVER (PARTITION BY address ORDER BY id ASC) FROM transactions WHERE owner=$1) st WHERE st.row_number=1`,
    [owner]
  )).rows.map((x) => x.address);
}

async function isProfileHistoricalAsset(owner, address) {
  debug('isProfileHistoricalAsset');

  return parseInt((await db.query(
    `SELECT COUNT(1) FROM transactions WHERE owner=$1 AND address=$2 LIMIT 1`,
    [owner, address]
  )).rows[0].count) === 1;
}

async function getProfile(owner) {
  debug('getProfile');

  const results = await db.query(
    `SELECT owner, name, thumbnail FROM profiles WHERE owner=$1 LIMIT 1`,
    [owner]
  );
  if (results.rows.length === 0) {
    return null;
  }
  return results.rows[0];
}

function setProfile(profile) {
  debug('setProfile');

  return db.query(
    `INSERT INTO profiles (owner, name, thumbnail) VALUES ($1, $2, $3) ON CONFLICT(owner) DO UPDATE SET name=$2, thumbnail=$3`,
    [profile.owner, profile.name, profile.thumbnail]
  );
}

async function queryProfileBySearch(search) {
  debug(`queryProfilenBySearch`);
  
  if (search === null || search === undefined || search.trim() === '' || search.trim().length > 50) {
    return [];
  }

  return (await db.query(
    `SELECT owner, (SELECT SUM(similarity((owner || ' ' || name), s)) FROM UNNEST(CAST($1 AS TEXT[])) s) AS sim FROM profiles WHERE (owner || ' ' || name) ILIKE ALL(CAST($1 AS TEXT[])) ORDER BY sim DESC LIMIT 50`,
    [search.trim().split(' ').map((x) => `%${x}%`)]
  )).rows.map((x) => x.owner);
}

async function queryProfileByTradeCount() {
  return (
    await db.query(`SELECT profileStats.owner FROM profileStats INNER JOIN profiles ON profileStats.owner=profiles.owner ORDER BY tradeCount DESC LIMIT 50`)
  ).rows.map((x) => x.owner);
};

async function queryProfileBy(search) {
  debug(`queryProfilenBySearch`);
  
  if (search === null || search === undefined || search.trim() === '' || search.trim().length > 50) {
    return [];
  }

  return (await db.query(
    `SELECT owner, (SELECT SUM(similarity((owner || ' ' || name), s)) FROM UNNEST(CAST($1 AS TEXT[])) s) AS sim FROM profiles WHERE (owner || ' ' || name) ILIKE ALL(CAST($1 AS TEXT[])) ORDER BY sim DESC LIMIT 50`,
    [search.trim().split(' ').map((x) => `%${x}%`)]
  )).rows.map((x) => x.owner);
}

async function queryProfileByEarnings() {
  debug(`queryProfileByEarnings`);
  return (await db.query(
    `SELECT profileStats.owner FROM profileStats INNER JOIN profiles ON profileStats.owner=profiles.owner ORDER BY (CAST(royaltyVolume AS bigint)) + (CAST(sellVolume AS bigint)) - (CAST(buyVolume AS bigint)) DESC LIMIT 100`
  )).rows.map((x) => x.owner);
}

async function getCollection(handle) {
  debug('getCollection');

  const results = await db.query(
    `SELECT handle, owner, name, thumbnail, description FROM collections WHERE handle=$1`,
    [handle]
  );
  if (results.rows.length === 0) {
    return {
      handle: handle,
      owner: null,
      name: null,
      thumbnail: null,
      description: null,
    };
  }
  return results.rows[0];
}

async function getCollections() {
  return (await db.query(`SELECT handle, owner, name, thumbnail, description FROM collections`)).rows;
};

async function getItemCollection(address) {
  debug('getItemCollection');

  const results = await db.query(
    `SELECT collection FROM assets WHERE address=$1`,
    [address]
  );
  if (results.rows.length === 0) {
    return null;
  }
  return results.rows[0].collection;
}

async function queryCollectionByOwner(owner) {
  debug('queryCollectionByOwner');

  return (
    await db.query(
      `SELECT handle FROM collections WHERE owner=$1 ORDER BY id`,
      [owner]
    )
  ).rows.map((x) => x.handle);
}

async function queryCollectionBySearch(search) {
  debug(`queryCollectionBySearch`);
  
  if (search === null || search === undefined || search.trim() === '' || search.trim().length > 50) {
    return [];
  }

  return (await db.query(
    `SELECT handle, (SELECT SUM(similarity((handle || ' ' || name || ' ' || description), s)) FROM UNNEST(CAST($1 AS TEXT[])) s) AS sim FROM collections WHERE (handle || ' ' || name || ' ' || description) ILIKE ALL(CAST($1 AS TEXT[])) ORDER BY sim DESC LIMIT 50`,
    [search.trim().split(' ').map((x) => `%${x}%`)]
  )).rows.map((x) => x.handle);
};

async function queryUnassignedNftsByOwner(owner) {
  debug('queryUnassignedNftsByOwner');

  return (
    await db.query(
      `SELECT nftStats.address FROM nftStats INNER JOIN assets ON nftStats.address=assets.address WHERE nftStats.creator=$1 AND assets.collection IS NULL ORDER BY assets.id ASC`,
      [owner]
    )
  ).rows.map((x) => x.address);
}

function setCollection(collection) {
  debug('setCollection');

  return db.query(
    `INSERT INTO collections (handle, owner, name, thumbnail, description) VALUES ($1, COALESCE($2, ''), $3, $4, $5) ON CONFLICT(handle) DO UPDATE SET name=$3, thumbnail=$4, description=$5`,
    [collection.handle, collection.owner, collection.name, collection.thumbnail, collection.description]
  );
}

async function setCollectionItem(address, handle) {
  debug('setCollectionItem');

  return db.query(
    `UPDATE assets SET collection=$1 WHERE address=$2`,
    [handle, address]
  );
}

async function getCollectionItems(handle) {
  debug('getCollectionItems');

  return (
    await db.query(
      `SELECT address FROM assets WHERE collection=$1 ORDER BY id ASC`,
      [handle]
    )
  ).rows.map((x) => x.address);
}

async function getCollectionStats(handle) {
  debug('getCollectionStats');

  return (
    await db.query(
    `SELECT COUNT(1) AS count, COALESCE(SUM(nftStats.tradeCount), 0) AS "tradeCount", COALESCE(SUM(CAST(nftStats.tradeVolume AS bigint) / 100000000), 0) AS "tradeVolume" FROM assets INNER JOIN nftStats ON assets.address=nftStats.address WHERE assets.collection=$1`,
    [handle]
  )).rows[0];
}

async function getNftStats(address) {
  debug('getNftStats');

  const results = await db.query(
    `SELECT address, creator, owner, listHeight as "listHeight", tradeHeight as "tradeHeight", tradeCount as "tradeCount", tradeVolume as "tradeVolume", price, tradeCountScaled as "tradeCountScaled", tradeVolumeScaled as "tradeVolumeScaled" FROM nftStats WHERE address=$1`,
    [address]
  );
  if (results.rows.length === 0) {
    return {
      address: address,
      creator: null,
      owner: null,
      listHeight: null,
      tradeHeight: null,
      tradeCount: 0,
      tradeVolume: "0",
      price: null,
      tradeCountScaled: 0,
      tradeVolumeScaled: 0,
    };
  }
  return results.rows[0];
}

function setNftStats(stats) {
  debug('setNftStats');

  return db.query(
    `INSERT INTO nftStats (address, creator, owner, listHeight, tradeHeight, tradeCount, tradeVolume, price, tradeCountScaled, tradeVolumeScaled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT(address) DO UPDATE SET creator=$2 ,owner=$3, listHeight=$4, tradeHeight=$5, tradeCount=$6, tradeVolume=$7, price=$8, tradeCountScaled=$9, tradeVolumeScaled=$10`,
    [stats.address, stats.creator, stats.owner, stats.listHeight, stats.tradeHeight, stats.tradeCount, stats.tradeVolume, stats.price, stats.tradeCountScaled, stats.tradeVolumeScaled]
  );
}

async function getProfileStats(owner) {
  debug('getProfileStats');

  const results = await db.query(
    `SELECT owner, firstListHeight as "firstListHeight", lastListHeight as "lastListHeight", listCount as "listCount", tradeHeight as "tradeHeight", tradeCount as "tradeCount", sellVolume as "sellVolume", buyVolume as "buyVolume", listSoldCount as "listSoldCount", royaltyVolume as "royaltyVolume" FROM profileStats WHERE owner=$1`,
    [owner]
  );
  if (results.rows.length === 0) {
    return {
      owner: owner,
      firstListHeight: null,
      lastListHeight: null,
      listCount: 0,
      tradeHeight: null,
      tradeCount: 0,
      sellVolume: "0",
      buyVolume: "0",
      listSoldCount: 0,
      royaltyVolume: "0"
    };
  }
  return results.rows[0];
}

async function getProfileCreatedCount(owner) {
  debug('getProfileCreatedCount');
  return (await db.query(
    `SELECT COUNT(1) FROM nftStats WHERE creator=$1`,
    [owner]
  )).rows[0].count;
}

async function getProfileCollectionCount(owner) {
  debug('getProfileCollectionCount');
  return (await db.query(
    `SELECT COUNT(1) FROM collections WHERE owner=$1`,
    [owner]
  )).rows[0].count;
}

async function getProfileHistoricalCount(owner) {
  debug('getProfileHistoricalCount');
  return (await db.query(
    `SELECT COUNT(1) FROM (SELECT address, ROW_NUMBER() OVER (PARTITION BY address ORDER BY id ASC) FROM transactions WHERE owner=$1) st WHERE st.row_number=1`,
    [owner]
  )).rows[0].count;
}

function setProfileStats(stats) {
  debug(`setProfileStats`);

  return db.query(
    `INSERT INTO profileStats (owner, firstListHeight, lastListHeight, listCount, tradeHeight, tradeCount, sellVolume, buyVolume, listSoldCount, royaltyVolume) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT(owner) DO UPDATE SET firstListHeight=$2, lastListHeight=$3, listCount=$4, tradeHeight=$5, tradeCount=$6, sellVolume=$7, buyVolume=$8, listSoldCount=$9, royaltyVolume=$10`,
    [stats.owner, stats.firstListHeight, stats.lastListHeight, stats.listCount, stats.tradeHeight, stats.tradeCount, stats.sellVolume, stats.buyVolume, stats.listSoldCount, stats.royaltyVolume]
  );
}

// WARNING: SQL INJECTION POSSIBLE.
async function queryNft(key, direction, offset, limit) {
  debug(`queryNft`);

  if (
    ![
      "listHeight",
      "tradeHeight",
      "tradeCount",
      "tradeVolume",
      "price",
    ].includes(key)
  ) {
    return null;
  }
  if (!["ASC", "DESC"].includes(direction)) {
    return null;
  }
  if (!Number.isInteger(offset)) {
    return null;
  }
  if (!Number.isInteger(limit) || limit > 100) {
    return null;
  }
  return (
    await db.query(
      `SELECT address FROM nftStats WHERE ${key} IS NOT NULL ORDER BY CAST(${key} AS DOUBLE PRECISION) ${direction} LIMIT ${limit} OFFSET ${offset}`
    )
  ).rows.map((x) => x.address);
}

async function queryNftBySearch(search) {
  debug(`queryNftBySearch`);

  if (search === null || search === undefined || search.trim() === '' || search.trim().length > 50) {
    return [];
  }

  return (await db.query(
    `SELECT address, (SELECT SUM(similarity((address || ' ' || name || ' ' || tags || ' ' || description), s)) FROM UNNEST(CAST($1 AS TEXT[])) s) AS sim FROM assets WHERE (address || ' ' || name || ' ' || tags || ' ' || description) ILIKE ALL(CAST($1 AS TEXT[])) ORDER BY sim DESC LIMIT 50`,
    [search.trim().split(' ').map((x) => `%${x}%`)]
  )).rows.map((x) => x.address);
};

async function queryNftByNewest(beforeId) {
  debug(`queryNftByNewest`);

  if (beforeId === null) {
    return (await db.query(
      `SELECT id, address FROM assets ORDER BY id DESC LIMIT 100`
    )).rows;
  } else {
    return (await db.query(
      `SELECT id, address FROM assets WHERE id < $1 ORDER BY id DESC LIMIT 100`,
      [beforeId]
    )).rows;
  }
}

async function queryCollectionByScaled(key, decay, height, limit) {
  debug(`queryCollectionByScaled`);

  // Prevent injection.
  if (!["tradeCountScaled", "tradeVolumeScaled", "tradeVolume"].includes(key)) {
    return null;
  }
  if (!Number.isInteger(parseInt(height))) {
    return null;
  }
  if (!Number.isInteger(parseInt(limit))) {
    return null;
  }

  return (
    await db.query(
      `SELECT COALESCE(SUM(CAST(nftStats.${key} AS DOUBLE PRECISION) * POWER($1, $2 - nftStats.tradeHeight)), 0) AS activity, assets.collection AS handle FROM nftStats INNER JOIN assets ON nftStats.address=assets.address WHERE assets.collection IS NOT NULL GROUP BY assets.collection ORDER by activity DESC LIMIT ${parseInt(limit)}`,
      [decay, height]
    )
  ).rows.map((x) => x.handle);
}

async function queryCollectionByValuable() {
  return (
    await db.query(
      `SELECT handle FROM (SELECT SUM(tradeCount) as tradeCount, SUM(CAST(tradeVolume AS DOUBLE PRECISION)) as tradeVolume, assets.collection AS handle FROM nftStats INNER JOIN assets ON nftStats.address=assets.address WHERE assets.collection IS NOT NULL GROUP BY assets.collection) st WHERE tradeCount > 0 ORDER BY (tradeVolume / tradeCount) DESC LIMIT 100`
    )
  ).rows.map((x) => x.handle);

}

async function getPlatformStats() {
  debug('getPlatformStats');

  return (await db.query(
    `SELECT SUM(CAST(tradeVolume AS bigint) / 100000000) AS "totalVolume" FROM nftStats`)).rows[0];
}
