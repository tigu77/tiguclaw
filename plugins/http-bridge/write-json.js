export const writeJson = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
};
//# sourceMappingURL=write-json.js.map