module.exports = {
  apps: [
    {
      name: "listjetgo-panel",
      cwd: "C:\\Users\\pc\\Desktop\\ebay listing\\backend\\panel",
      script: "C:\\Program Files\\nodejs\\npm.cmd",
      args: "run start",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
}
