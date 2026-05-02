// 2026-01-02 10:04

const url = "https://my.ippure.com/v1/info"
const MarkIP = ($argument || 'false').toLowerCase() === 'true'
const cacheKey = "cached_inbound_desc"

async function getIPs() {
    let info = await new Promise((resolve) => {
        $httpClient.get(url, (err, resp, data) => resolve(err ? null : JSON.parse(data)))
    })

    if (!info) {
        $done({ title: "请求失败", content: "N/A", icon: "network.slash", 'title-color': "#FF3B30" })
        return
    }

    async function getDeepPolicy(name) {
        return new Promise((resolve) => {
            $httpAPI("GET", `/v1/policy_groups/select?group_name=${encodeURIComponent(name)}`, {}, (data) => {
                if (data && data.policy) {
                    if (data.policy === "PROXY" || data.policy === "ALL") {
                        getDeepPolicy(data.policy).then(resolve)
                    } else {
                        resolve(data.policy)
                    }
                } else {
                    resolve(name)
                }
            })
        })
    }

    let nodeName = await getDeepPolicy("PROXY")

    let inboundIP = await new Promise((resolve) => {
        $httpAPI("GET", "/v1/requests/recent", {}, (data) => {
            const req = data.requests.find(r => (r.policyName === nodeName || r.policyName === "PROXY") && r.remoteAddress);
            resolve(req ? req.remoteAddress.replace(/\s*\(Proxy\)\s*/, '') : null);
        });
    })

    let inboundDesc = ""
    if (inboundIP && inboundIP !== "127.0.0.1") {
        inboundDesc = await new Promise((resolve) => {
            $httpClient.get(`https://ip.taobao.com/outGetIpInfo?ip=${inboundIP}&accessKey=alibaba-inc`, (err, resp, data) => {
                try {
                    const d = JSON.parse(data);
                    if (d.code === 0 && d.data) {
                        const s = (t) => t ? t.replace(/XX/g, '').trim() : '';
                        let country = d.data.country.replace(/中華民國|中华民国|台灣/g, "台湾");
                        
                        if (country !== "中国" && country !== "台湾" && country !== " can't find") {
                            $httpClient.get(`http://ip-api.com/json/${inboundIP}?lang=zh-CN`, (err2, resp2, data2) => {
                                try {
                                    const d2 = JSON.parse(data2);
                                    if (d2.status === "success") {
                                        const getEmoji = (cc) => cc.toUpperCase().replace(/./g, char => String.fromCodePoint(char.charCodeAt(0) + 127397));
                                        let cCode = d2.countryCode;
                                        let cName = d2.country.replace(/中華民國|中华民国|台灣/g, "台湾");
                                        let emoji = (cCode === "TW" || cName === "台湾") ? "🇨🇳" : getEmoji(cCode);
                                        let res = `(${emoji} ${cName} ${d2.isp})`.replace(/\s+/g, ' ');
                                        $persistentStore.write(res, cacheKey + inboundIP);
                                        resolve(res);
                                    } else { resolve(""); }
                                } catch (e) { resolve(""); }
                            });
                        } else {
                            let region = s(d.data.region).replace(/台灣/g, "台湾");
                            let city = s(d.data.city).replace(/台灣/g, "台湾");
                            let isp = s(d.data.isp).replace("中国", "");
                            let emoji = "🇨🇳 ";
                            let area = "";
                            if (country === "台湾") {
                                area = "台湾";
                            } else {
                                let parts = [];
                                if (region) parts.push(region);
                                if (city && city !== region) parts.push(city);
                                area = parts.join(" ");
                            }
                            let result = `(${emoji}${area} ${isp})`.replace(/\s+/g, ' ');
                            $persistentStore.write(result, cacheKey + inboundIP);
                            resolve(result);
                        }
                    } else {
                        resolve($persistentStore.read(cacheKey + inboundIP) || "");
                    }
                } catch (e) { 
                    resolve($persistentStore.read(cacheKey + inboundIP) || ""); 
                }
            });
        });
    }

    let v4 = info.ipv4 || (info.ip && info.ip.includes('.') ? info.ip : null)
    let v6 = info.ipv6 || (info.ip && info.ip.includes(':') ? info.ip : null)

    if (!v4) {
        v4 = await new Promise((resolve) => {
            $httpClient.get("https://v4.ident.me", (err, resp, data) => resolve(err ? null : data))
        })
    }
    
    if (!v6) {
        v6 = await new Promise((resolve) => {
            $httpClient.get({url: "https://v6.ident.me", timeout: 2}, (err, resp, data) => resolve(err ? null : data))
        })
    }

    const formatIP = (ip) => MarkIP ? maskIP(ip) : ip
    
    let contentList = []
    if (inboundIP) {
        contentList.push(`IP 入口：${formatIP(inboundIP)}${inboundDesc ? " " + inboundDesc : ""}`)
    }
    
    if (v4) contentList.push(`IP 落地：${formatIP(v4)} (IPv4)`)
    if (v6 && v6.includes(':')) contentList.push(`IP 落地：${formatIP(v6)} (IPv6)`)
    
    contentList.push(`IP 来源：${info.isBroadcast ? "广播 IP" : "原生 IP"}`)
    contentList.push(`IP 属性：${info.isResidential ? "家庭宽带" : "机房 IP"}`)
    contentList.push(`IP 服务商：AS${info.asn} - ${info.asOrganization}`)

    const risk = info.fraudScore
    let riskText, titleColor
    if (risk == null) {
        riskText = 'N/A'; titleColor = "#007AFF"
    } else if (risk <= 15) {
        riskText = `极度纯净 (${risk}%)`; titleColor = "#1a73e8"
    } else if (risk <= 25) {
        riskText = `纯净 (${risk}%)`; titleColor = "#34C759"
    } else if (risk <= 40) {
        riskText = `中性 (${risk}%)`; titleColor = "#8E8E93"
    } else if (risk <= 50) {
        riskText = `轻度风险 (${risk}%)`; titleColor = "#FFD60A"
    } else if (risk <= 70) {
        riskText = `中度风险 (${risk}%)`; titleColor = "#FF9500"
    } else {
        riskText = `极高风险 (${risk}%)`; titleColor = "#FF3B30"
    }
    contentList.push(`IP 风险值：${riskText}`)

    $done({
        title: nodeName,
        content: contentList.join("\n"),
        icon: "network",
        'title-color': titleColor
    })
}

getIPs()

function maskIP(ip) { if (!ip) return ''; if (ip.includes('.')) { const p = ip.split('.'); return `${p[0]}.${p[1]}.*.*` } return ip.substring(0, 9) + '...' }
