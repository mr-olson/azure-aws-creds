var nodeExternals = require('webpack-node-externals');
var path = require('path');

module.exports = {
  entry: {
    app: './src/main.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  target: 'node',
  externals: [nodeExternals({
    whitelist: [
      'jquery',
      'bootstrap/dist',
      'datatables.net-dt/css'
    ]
  })]
};
