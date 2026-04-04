module.exports = {
  apps: [
    {
      name: "kingcode-web",
      script: "server.js",
      cwd: __dirname + "/..",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
