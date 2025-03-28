'use strict'

var EventEmitter = require('events').EventEmitter
var util = require('util')
var utils = require('../utils')

var NativeQuery = (module.exports = function (config, values, callback) {
  EventEmitter.call(this)
  config = utils.normalizeQueryConfig(config, values, callback)
  this.text = config.text
  this.values = config.values
  this.name = config.name
  this.queryMode = config.queryMode
  this.callback = config.callback
  this.state = 'new'
  this._arrayMode = config.rowMode === 'array'

  // if the 'row' event is listened for
  // then emit them as they come in
  // without setting singleRowMode to true
  // this has almost no meaning because libpq
  // reads all rows into memory befor returning any
  this._emitRowEvents = false
  this.on(
    'newListener',
    function (event) {
      if (event === 'row') this._emitRowEvents = true
    }.bind(this)
  )
})

util.inherits(NativeQuery, EventEmitter)

var errorFieldMap = {
  /* eslint-disable quote-props */
  sqlState: 'code',
  statementPosition: 'position',
  messagePrimary: 'message',
  context: 'where',
  schemaName: 'schema',
  tableName: 'table',
  columnName: 'column',
  dataTypeName: 'dataType',
  constraintName: 'constraint',
  sourceFile: 'file',
  sourceLine: 'line',
  sourceFunction: 'routine',
}

NativeQuery.prototype.handleError = function (err) {
  // copy pq error fields into the error object
  var fields = this.native.pq.resultErrorFields()
  if (fields) {
    for (var key in fields) {
      var normalizedFieldName = errorFieldMap[key] || key
      err[normalizedFieldName] = fields[key]
    }
  }

  // For maxResultSize exceeded errors, make sure we emit the error to the client too
  if (err.code === 'RESULT_SIZE_EXCEEDED') {
    if (this.native && this.native.connection) {
      // Need to emit the error on the client/connection level too
      process.nextTick(() => {
        this.native.connection.emit('error', err)
      })
    }
  }

  if (this.callback) {
    this.callback(err)
  } else {
    this.emit('error', err)
  }
  this.state = 'error'
}

NativeQuery.prototype.then = function (onSuccess, onFailure) {
  return this._getPromise().then(onSuccess, onFailure)
}

NativeQuery.prototype.catch = function (callback) {
  return this._getPromise().catch(callback)
}

NativeQuery.prototype._getPromise = function () {
  if (this._promise) return this._promise
  this._promise = new Promise(
    function (resolve, reject) {
      this._once('end', resolve)
      this._once('error', reject)
    }.bind(this)
  )
  return this._promise
}

NativeQuery.prototype.submit = function (client) {
  this.state = 'running'
  var self = this
  this.native = client.native
  client.native.arrayMode = this._arrayMode

  // Get the maxResultSize from the client if it's set
  this._maxResultSize = client._maxResultSize

  var after = function (err, rows, results) {
    client.native.arrayMode = false
    setImmediate(function () {
      self.emit('_done')
    })

    // handle possible query error
    if (err) {
      return self.handleError(err)
    }

    // Check the result size if maxResultSize is configured
    if (self._maxResultSize) {
      // Calculate result size (rough approximation)
      let resultSize = 0

      // For multiple result sets
      if (results.length > 1) {
        for (let i = 0; i < rows.length; i++) {
          resultSize += self._calculateResultSize(rows[i])
        }
      } else if (rows.length > 0) {
        resultSize = self._calculateResultSize(rows)
      }

      // If the size limit is exceeded, generate an error
      if (resultSize > self._maxResultSize) {
        const error = new Error('Query result size exceeded the configured limit')
        error.code = 'RESULT_SIZE_EXCEEDED'
        error.resultSize = resultSize
        error.maxResultSize = self._maxResultSize
        return self.handleError(error)
      }
    }

    // emit row events for each row in the result
    if (self._emitRowEvents) {
      if (results.length > 1) {
        rows.forEach((rowOfRows, i) => {
          rowOfRows.forEach((row) => {
            self.emit('row', row, results[i])
          })
        })
      } else {
        rows.forEach(function (row) {
          self.emit('row', row, results)
        })
      }
    }

    // handle successful result
    self.state = 'end'
    self.emit('end', results)
    if (self.callback) {
      self.callback(null, results)
    }
  }

  if (process.domain) {
    after = process.domain.bind(after)
  }

  // named query
  if (this.name) {
    if (this.name.length > 63) {
      /* eslint-disable no-console */
      console.error('Warning! Postgres only supports 63 characters for query names.')
      console.error('You supplied %s (%s)', this.name, this.name.length)
      console.error('This can cause conflicts and silent errors executing queries')
      /* eslint-enable no-console */
    }
    var values = (this.values || []).map(utils.prepareValue)

    // check if the client has already executed this named query
    // if so...just execute it again - skip the planning phase
    if (client.namedQueries[this.name]) {
      if (this.text && client.namedQueries[this.name] !== this.text) {
        const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`)
        return after(err)
      }
      return client.native.execute(this.name, values, after)
    }
    // plan the named query the first time, then execute it
    return client.native.prepare(this.name, this.text, values.length, function (err) {
      if (err) return after(err)
      client.namedQueries[self.name] = self.text
      return self.native.execute(self.name, values, after)
    })
  } else if (this.values) {
    if (!Array.isArray(this.values)) {
      const err = new Error('Query values must be an array')
      return after(err)
    }
    var vals = this.values.map(utils.prepareValue)
    client.native.query(this.text, vals, after)
  } else if (this.queryMode === 'extended') {
    client.native.query(this.text, [], after)
  } else {
    client.native.query(this.text, after)
  }
}

// Helper method to estimate the size of a result set
NativeQuery.prototype._calculateResultSize = function (rows) {
  let size = 0

  // For empty results, return 0
  if (!rows || rows.length === 0) {
    return 0
  }

  // For array mode, calculate differently
  if (this._arrayMode) {
    // Just use a rough approximation based on number of rows
    return rows.length * 100
  }

  // For each row, approximate its size
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]

    // Add base row size
    size += 24 // Overhead per row

    // Add size of each column
    for (const key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        const value = row[key]

        // Add key size
        size += key.length * 2 // Assume 2 bytes per character

        // Add value size based on type
        if (value === null || value === undefined) {
          size += 8
        } else if (typeof value === 'string') {
          size += value.length * 2 // Assume 2 bytes per character
        } else if (typeof value === 'number') {
          size += 8
        } else if (typeof value === 'boolean') {
          size += 4
        } else if (value instanceof Date) {
          size += 8
        } else if (Buffer.isBuffer(value)) {
          size += value.length
        } else if (Array.isArray(value)) {
          size += 16 + value.length * 8
        } else {
          // For objects, use a rough estimate
          size += 32 + JSON.stringify(value).length * 2
        }
      }
    }
  }

  return size
}
