var mongoose = require( 'mongoose' );

var Block     = mongoose.model( 'Block' );
var Transaction = mongoose.model( 'Transaction' );
var filters = require('./filters');

var _ = require('lodash');
var async = require('async');
var BigNumber = require('bignumber.js');

var config = {};
try {
  config = require('../config.json');
} catch(e) {
  if (e.code == 'MODULE_NOT_FOUND') {
    console.log('No config file found. Using default configuration... (tools/config.json)');
    config = require('../tools/config.json');
  } else {
    throw e;
    process.exit(1);
  }
}

module.exports = function(app){
  var web3relay = require('./web3relay');

  var DAO = require('./dao');
  var Token = require('./token');

  var compile = require('./compiler');
  var fiat = require('./fiat');
  var stats = require('./stats');
  var richList = require('./richlist');

  /* 
    Local DB: data request format
    { "address": "0x1234blah", "txin": true } 
    { "tx": "0x1234blah" }
    { "block": "1234" }
  */
  app.post('/richlist', richList);
  app.post('/addr', getAddr);
  app.post('/addr_count', getAddrCounter);
  app.post('/tx', getTx);
  app.post('/block', getBlock);
  app.post('/data', getData);

  app.post('/daorelay', DAO);
  app.post('/tokenrelay', Token);  
  app.post('/web3relay', web3relay.data);
  app.post('/compile', compile);

  app.post('/fiat', fiat);
  app.post('/stats', stats);
  app.post('/supply', getTotalSupply);
  app.get('/supply/:act', getTotalSupply);
  app.get('/supply', getTotalSupply);
}

var getAddr = function(req, res){
  // TODO: validate addr and tx
  var addr = req.body.addr.toLowerCase();
  var count = parseInt(req.body.count);

  var limit = parseInt(req.body.length);
  var start = parseInt(req.body.start);

  var data = { draw: parseInt(req.body.draw), recordsFiltered: count, recordsTotal: count, mined: 0 };

  var addrFind = Transaction.find( { $or: [{"to": addr}, {"from": addr}] })  

  var sortOrder = '-blockNumber';
  if (req.body.order && req.body.order[0] && req.body.order[0].column) {
    // date or blockNumber column
    if (req.body.order[0].column == 1 || req.body.order[0].column == 6) {
      if (req.body.order[0].dir == 'asc') {
        sortOrder = 'blockNumber';
      }
    }
  }

  addrFind.lean(true).sort(sortOrder).skip(start).limit(limit)
    .exec("find", function (err, docs) {
      if (docs)
        data.data = filters.filterTX(docs, addr);
      else
        data.data = [];
      res.write(JSON.stringify(data));
      res.end();
    });

};
var getAddrCounter = function(req, res) {
  var addr = req.body.addr.toLowerCase();
  var count = parseInt(req.body.count);
  var data = { recordsFiltered: count, recordsTotal: count, mined: 0 };

  async.waterfall([
  function(callback) {

  Transaction.count({ $or: [{"to": addr}, {"from": addr}] }, function(err, count) {
    if (!err && count) {
      // fix recordsTotal
      data.recordsTotal = count;
      data.recordsFiltered = count;
    }
    callback(null);
  });

  }, function(callback) {

  Block.count({ "miner": addr }, function(err, count) {
    if (!err && count) {
      data.mined = count;
    }
    callback(null);
  });

  }], function (err) {
    res.write(JSON.stringify(data));
    res.end();
  });

};
var getBlock = function(req, res) {
  // TODO: support queries for block hash
  var txQuery = "number";
  var number = parseInt(req.body.block);

  var blockFind = Block.findOne( { number : number }).lean(true);
  blockFind.exec(function (err, doc) {
    if (err || !doc) {
      console.error("BlockFind error: " + err)
      console.error(req.body);
      res.write(JSON.stringify({"error": true}));
    } else {
      var block = filters.filterBlocks([doc]);
      res.write(JSON.stringify(block[0]));
    }
    res.end();
  });
};

/** 
 * calc totalSupply
 * total supply = genesis alloc + miner rewards + estimated uncle rewards
 */
var getTotalSupply = function(req, res) {
  var act;
  if (req.params.act && ['total', 'circulatingSupply', 'totalSupply', 'genesisAlloc', 'minerRewards', 'uncleRewards'].indexOf(req.params.act) > -1) {
    act = req.params.act;
    if (act === 'total') {
      act = 'totalSupply';
    }
  }

  Block.findOne({}).lean(true).sort('-number').exec(function (err, latest) {
    if(err || !latest) {
      console.error("getTotalSupply error: " + err)
      res.write(JSON.stringify({"error": true}));
      res.end();
    } else {
      console.log("getTotalSupply: latest block: " + latest.number);
      var blockNumber = latest.number;

      var total = new BigNumber(0);
      var genesisAlloc = new BigNumber(0);
      var blocks = [];

      var rewards = {
        enableECIP1017: false,
        estimateUncle: 0.050, /* true: aggregate db // number(fractioal value): uncle rate // false: disable */
        genesisAlloc: 49922489.5246415,
        blocks: [
          /* will be regeneragted later for ECIP1017 enabled case */
          { start:        1, reward: 9e+18, uncle:  0.90625 },
          { start:   600000, reward: 5e+18, uncle:  0.90625 },
        ]
      };

      if (config.rewards) {
        _.extend(rewards, config.rewards);
      }

      if (rewards && rewards.blocks) {
        // get genesis alloc
        if (typeof rewards.genesisAlloc === "object") {
          genesisAlloc = new BigNumber(rewards.genesisAlloc.total) || new BigNumber(0);
        } else {
          genesisAlloc = new BigNumber(rewards.genesisAlloc) || new BigNumber(0);
        }
        genesisAlloc = genesisAlloc.times(new BigNumber(1e+18));

        if (rewards.enableECIP1017) {
          // regenerate reward block config for ETC
          // https://github.com/ethereumproject/ECIPs/blob/master/ECIPs/ECIP-1017.md
          var reward = new BigNumber(5e+18);
          var uncleRate = new BigNumber(1).div(32).plus(new BigNumber(7).div(8)); // 1/32(block miner) + 7/8(uncle miner)
          blocks.push({start: 1, end: 5000000, reward, uncle: uncleRate});

          reward = reward.times(0.8); // reduce 20%
          uncleRate = new BigNumber(1).div(32).times(2); // 1/32(block miner) + 1/32(uncle miner)
          blocks.push({start: 5000001, end: 10000000, reward, uncle: uncleRate});
          currentBlock = 10000001;
          var i = 2;
          var lastBlock = blockNumber;
          for (; lastBlock > currentBlock; currentBlock += 5000000) {
            var start = blocks[i - 1].end + 1;
            var end = start + 5000000 - 1;
            reward = reward.times(0.8); // reduce 20%
            blocks.push({start, end, reward, uncle: blocks[i - 1].uncle});
            i++;
          }
          rewards.blocks = blocks;
          blocks = [];
        }

        // check reward blocks, calc total miner's reward
        rewards.blocks.forEach(function(block, i) {
          if (blockNumber > block.start) {
            var startBlock = block.start;
            if (startBlock < 0) {
              startBlock = 0;
            }
            var endBlock = blockNumber;
            var reward = new BigNumber(block.reward);
            if (rewards.blocks[i + 1] && blockNumber > rewards.blocks[i + 1].start) {
              endBlock = rewards.blocks[i + 1].start - 1;
            }
            blocks.push({start: startBlock, end: endBlock, reward: reward, uncle: block.uncle });

            var blockNum = endBlock - startBlock;
            total = total.plus(reward.times(new BigNumber(blockNum)));
          }
        });
      }

      var totalSupply = total.plus(genesisAlloc);
      // long-term reserves of the development organization
      var circulatingSupply = totalSupply.minus(17000000e+18);
      var ret = { "height": blockNumber, "circulatingSupply": circulatingSupply.div(1e+18), "totalSupply": totalSupply.div(1e+18), "genesisAlloc": genesisAlloc.div(1e+18), "minerRewards": total.div(1e+18) };
      if (req.method === 'POST' && typeof rewards.genesisAlloc === 'object') {
        ret.genesisAlloc = rewards.genesisAlloc;
      }

      // estimate uncleRewards
      var uncleRewards = [];
      if (typeof rewards.estimateUncle === 'boolean' && rewards.estimateUncle && blocks.length > 0) {
        // aggregate uncle blocks (slow)
        blocks.forEach(function(block) {
          Block.aggregate([
            { $match: { number: { $gte: block.start, $lt: block.end } } },
            { $group: { _id: null, uncles: { $sum: { $size: "$uncles" } } } }
          ]).exec(function(err, results) {
            if (err) {
              console.log(err);
            }
            if (results && results[0] && results[0].uncles) {
              // estimate Uncle Rewards
              var reward = block.reward.times(new BigNumber(results[0].uncles)).times(block.uncle);
              uncleRewards.push(reward);
            }
            if (uncleRewards.length === blocks.length) {
              var totalUncleRewards = new BigNumber(0);
              uncleRewards.forEach(function(reward) {
                totalUncleRewards = totalUncleRewards.plus(reward);
              });
              ret.uncleRewards = totalUncleRewards.div(1e+18);
              ret.totalSupply = totalSupply.plus(totalUncleRewards).div(1e+18);
              if (req.method === 'GET' && act) {
                res.write(ret[act].toString());
              } else {
                res.write(JSON.stringify(ret));
              }
              res.end();
            }
          });
        });
        return;
      } else if (typeof rewards.estimateUncle === 'number' && rewards.estimateUncle > 0) {
        // estimate Uncle rewards with uncle probability. (faster)
        blocks.forEach(function(block) {
          var blockcount = block.end - block.start;
          var reward = block.reward.times(new BigNumber(blockcount).times(rewards.estimateUncle)).times(block.uncle);
          uncleRewards.push(reward);
        });
        var totalUncleRewards = new BigNumber(0);
        uncleRewards.forEach(function(reward) {
          totalUncleRewards = totalUncleRewards.plus(reward);
        });
        ret.uncleRewards = totalUncleRewards.div(1e+18);
        ret.totalSupply = totalSupply.plus(totalUncleRewards).div(1e+18);
        ret.circulatingSupply = circulatingSupply.plus(totalUncleRewards).div(1e+18);
      }
      if (req.method === 'GET' && act) {
        res.write(ret[act].toString());
      } else {
        res.write(JSON.stringify(ret));
      }
      res.end();
    }
  });
};

var getTx = function(req, res){
  var tx = req.body.tx.toLowerCase();
  var txFind = Block.findOne( { "transactions.hash" : tx }, "transactions timestamp")
                  .lean(true);
  txFind.exec(function (err, doc) {
    if (!doc){
      console.log("missing: " +tx)
      res.write(JSON.stringify({}));
      res.end();
    } else {
      // filter transactions
      var txDocs = filters.filterBlock(doc, "hash", tx)
      res.write(JSON.stringify(txDocs));
      res.end();
    }
  });
};
/*
  Fetch data from DB
*/
var getData = function(req, res){
  // TODO: error handling for invalid calls
  var action = req.body.action.toLowerCase();
  var limit = req.body.limit

  if (action in DATA_ACTIONS) {
    if (isNaN(limit))
      var lim = MAX_ENTRIES;
    else
      var lim = parseInt(limit);  
    DATA_ACTIONS[action](lim, res);
  } else { 
    console.error("Invalid Request: " + action)
    res.status(400).send();
  }
};

/* 
  temporary blockstats here
*/
var latestBlock = function(req, res) {
  var block = Block.findOne({}, "totalDifficulty")
                      .lean(true).sort('-number');
  block.exec(function (err, doc) {
    res.write(JSON.stringify(doc));
    res.end();
  });
} 


var getLatest = function(lim, res, callback) {
  var blockFind = Block.find({}, "number transactions timestamp miner extraData")
                      .lean(true).sort('-number').limit(lim);
  blockFind.exec(function (err, docs) {
    callback(docs, res);
  });
}

/* get blocks from db */
var sendBlocks = function(lim, res) {
  var blockFind = Block.find({}, "number timestamp miner extraData")
                      .lean(true).sort('-number').limit(lim);
  blockFind.exec(function (err, docs) {
    if(!err && docs) {
      var blockNumber = docs[docs.length - 1].number;
      // aggregate transaction counters
      Transaction.aggregate([
        {$match: { blockNumber: { $gte: blockNumber } }},
        {$group: { _id: '$blockNumber', count: { $sum: 1 } }}
      ]).exec(function(err, results) {
        var txns = {};
        if (!err && results) {
          // set transaction counters
          results.forEach(function(txn) {
            txns[txn._id] = txn.count;
          });
          docs.forEach(function(doc) {
            doc.txn = txns[doc.number] || 0;
          });
        }
        res.write(JSON.stringify({"blocks": filters.filterBlocks(docs)}));
        res.end();
      });
    } else {
      console.log("blockFind error:" + err);
      res.write(JSON.stringify({"error": true}));
      res.end();
    }
  });
}

var sendTxs = function(lim, res) {
  Transaction.find({}).lean(true).sort('-blockNumber').limit(lim)
        .exec(function (err, txs) {
          res.write(JSON.stringify({"txs": txs}));
          res.end();
        });
}

const MAX_ENTRIES = 10;

const DATA_ACTIONS = {
  "latest_blocks": sendBlocks,
  "latest_txs": sendTxs
}

