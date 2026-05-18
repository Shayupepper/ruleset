// 2026-02-14 10:09

const urlIpApi = "http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,as,asname,isp,query"
const urlIpPure = "https://my.ippure.com/v1/info"
const MarkIP = false
const entryGroup = ($argument || '').trim()
const cacheKey = "cached_inbound_desc_v10"

const NORMALIZE_RE = /中華民國|中华民国|台灣/g

const normalizeName = s => s ? s.replace(NORMALIZE_RE, "台湾") : ''

function getFlagEmoji(countryCode) {
    if (!countryCode) return ''
    let code = countryCode.toUpperCase()
    if (code === 'TW') code = 'CN'
    const codePoints = code.split('').map(char => 127397 + char.charCodeAt(0))
    return String.fromCodePoint(...codePoints)
}

function maskIP(ip) {
    if (!ip) return ''
    if (ip.includes('.')) {
        const p = ip.split('.')
        return `${p[0]}.${p[1]}.*.*`
    }
    return ip.substring(0, 9) + '...'
}

function httpGet(url, timeout = 8000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeout)
        $httpClient.get(url, (err, resp, data) => {
            clearTimeout(timer)
            try { resolve(JSON.parse(data)) } catch(e) { resolve(null) }
        })
    })
}

async function queryIPInfo(ip) {
    const d = await httpGet(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,as,asname,isp`, 8000)
    let asnStr = (d && d.status === "success") ? (d.as || d.asname || "") : ""
    let area = (d && d.status === "success") ? (d.isp || d.asname || "").trim() : ""
    let flag = (d && d.countryCode) ? getFlagEmoji(d.countryCode) : ""
    let countryCode = (d && d.countryCode) ? d.countryCode : ""

    if (!area || !asnStr || (area === area.toUpperCase() && area.length <= 6)) {
        const d2 = await httpGet(`https://ipinfo.io/${ip}/json`, 8000)
        if (d2?.org) {
            asnStr = asnStr || d2.org
            area = (!area || (area === area.toUpperCase() && area.length <= 6))
                ? d2.org.replace(/^AS\d+\s*/, '').trim()
                : area
        }
    }

    asnStr = asnStr.trim()
    const asnNum = asnStr ? asnStr.split(' ')[0].replace('AS', '') : ""
    return { asnStr, asnNum, area, flag, countryCode, raw: d }
}

async function getDeepPolicy(name, depth = 0) {
    if (depth > 10) return name
    return new Promise((resolve) => {
        $httpAPI("GET", `/v1/policy_groups/select?group_name=${encodeURIComponent(name)}`, {}, (data) => {
            const next = data && data.policy
            if (next && next !== name) {
                getDeepPolicy(next, depth + 1).then(resolve)
            } else {
                resolve(name)
            }
        })
    })
}

async function resolveEntryPolicy() {
    const group = entryGroup || "Proxy"
    return await getDeepPolicy(group)
}

async function getIPv6() {
    const d = await httpGet("https://api6.ipify.org?format=json", 8000)
    if (!d) return null
    const ip = d.ip || null
    return ip && ip.includes(':') ? ip : null
}

async function getInboundIP(nodeName) {
    return new Promise((resolve) => {
        $httpAPI("GET", "/v1/requests/recent", {}, (data) => {
            const req = (data.requests || []).find(r => r.remoteAddress && /ip-api\.com|ipinfo\.io|ippure\.com/.test(r.URL) && /\(Proxy\)/.test(r.remoteAddress))
            resolve(req ? req.remoteAddress.replace(/\s*\(Proxy\)\s*/, '') : null)
        })
    })
}

async function getInboundDesc(inboundIP) {
    if (!inboundIP || inboundIP === "127.0.0.1") return { area: "", asn: "", asnNum: "", flag: "", countryCode: "" }

    const cached = $persistentStore.read(`${cacheKey}${inboundIP}`) || ""
    if (cached) {
        const parts = cached.split("|")
        const c = { area: parts[0] || "", asn: parts[1] || "", asnNum: parts[2] || "", flag: parts[3] || "", countryCode: parts[4] || "" }
        if (c.area && c.countryCode) return c
    }

    const parseCached = () => {
        const parts = cached.split("|")
        return { area: parts[0] || "", asn: parts[1] || "", asnNum: parts[2] || "", flag: parts[3] || "", countryCode: parts[4] || "" }
    }

    const [info, taobaoData] = await Promise.all([
        queryIPInfo(inboundIP),
        httpGet(`https://ip.taobao.com/outGetIpInfo?ip=${inboundIP}&accessKey=alibaba-inc`, 8000)
    ])

    if (!taobaoData || taobaoData.code !== 0 || !taobaoData.data) return parseCached()

    const s = t => (t && t !== "XX") ? t.trim() : ''
    let country = normalizeName(taobaoData.data.country)
    const { asnStr, asnNum, flag, countryCode } = info

    if (country !== "中国" && country !== "台湾" && country !== "澳门" && country !== "香港" && country !== " can't find") {
        if (!info.raw || info.raw.status !== "success") return parseCached()
        const area = info.area
        $persistentStore.write(`${area}|${asnStr}|${asnNum}|${flag}|${countryCode}`, `${cacheKey}${inboundIP}`)
        return { area, asn: asnStr, asnNum, flag, countryCode }
    } else {
        let region = normalizeName(s(taobaoData.data.region))
        let city = normalizeName(s(taobaoData.data.city))
        let isp = s(taobaoData.data.isp).replace("中国", "")
        let areaParts = []
        if (region && region !== "中国") areaParts.push(region)
        if (city && city !== region) areaParts.push(city)
        const area = `${areaParts.join(" ")} ${isp}`.replace(/\s+/g, ' ').trim()
        $persistentStore.write(`${area}|${asnStr}|${asnNum}|${flag}|${countryCode}`, `${cacheKey}${inboundIP}`)
        return { area, asn: asnStr, asnNum, flag, countryCode }
    }
}

async function getExitEmojiAndASN(exitIP, fallbackASN) {
    const info = await queryIPInfo(exitIP)
    if (!info.raw || info.raw.status !== "success") return { asn: fallbackASN || "N/A", asnNum: "", area: "", flag: "", countryCode: "" }
    return {
        asn: info.asnStr || fallbackASN || "N/A",
        asnNum: info.asnNum,
        area: info.area,
        flag: info.flag,
        countryCode: info.countryCode
    }
}

async function getIPs() {
    const [resApi, resPure, nodeName, exitIP6] = await Promise.all([
        httpGet(urlIpApi, 8000),
        httpGet(urlIpPure, 8000),
        resolveEntryPolicy(),
        getIPv6()
    ])

    const isDirect = nodeName === "DIRECT"
    const prefix = isDirect ? "本地 IP " : "代理 IP "

    const hasIPv4 = resApi && resApi.status === "success" && resApi.query
    const exitIPv4 = hasIPv4 ? resApi.query : null

    if (!exitIPv4 && !exitIP6) {
        $done({ title: "请求失败", content: "N/A", icon: "network.slash", 'title-color': "#007AFF" })
        return
    }

    const exitIP = exitIPv4 || exitIP6
    const fallbackASN = hasIPv4 ? (resApi.as || resApi.org || "N/A") : "N/A"

    const inboundIP = await getInboundIP(nodeName)

    const [inboundDesc, exitInfo] = await Promise.all([
        getInboundDesc(isDirect ? exitIP : inboundIP),
        getExitEmojiAndASN(exitIP, fallbackASN)
    ])

    const formatIP = ip => MarkIP ? maskIP(ip) : ip

    const formatBlock = (type, ipv4, ipv6, info, pfx) => {
        let lines = []
        if (ipv4) lines.push(`${pfx}${type}: ${formatIP(ipv4)}`)
        if (ipv6) lines.push(`${pfx}${type}: ${formatIP(ipv6)}`)
        if (info.flag && info.countryCode) lines.push(`${pfx}区域: ${info.flag} ${info.countryCode}`)
        if (info.asnNum) lines.push(`${pfx}ASN: AS${info.asnNum}`)
        if (info.area) lines.push(`${pfx}ASO: ${info.area}`)
        return lines.join("\n")
    }

    let ipBlocks = []
    let metaLines = []

    if (isDirect) {
        ipBlocks.push(formatBlock("入口", exitIPv4, null, inboundDesc, prefix))
        ipBlocks.push(formatBlock("出口", exitIPv4, exitIP6, exitInfo, prefix))
    } else {
        if (inboundIP && inboundIP !== "127.0.0.1") {
            ipBlocks.push(formatBlock("入口", inboundIP, null, inboundDesc, prefix))
        }
        ipBlocks.push(formatBlock("出口", exitIPv4, exitIP6, exitInfo, prefix))
    }

    if (resPure) {
        metaLines.push(`${prefix}来源: ${resPure.isBroadcast ? "广播 IP" : "原生 IP"}`)
        metaLines.push(`${prefix}属性: ${resPure.isResidential ? "住宅 IP" : "机房 IP"}`)
    }

    const risk = resPure ? resPure.fraudScore : null
    const riskLabel = risk == null ? 'N/A' : risk <= 15 ? '极度纯净' : risk <= 25 ? '纯净' : risk <= 40 ? '中性' : risk <= 50 ? '轻度风险' : risk <= 70 ? '中度风险' : '极高风险'
    metaLines.push(`${prefix}风险值: ${risk == null ? 'N/A' : `${risk}% ${riskLabel}`}`)

    const content = ipBlocks.join("\n\n") + "\n\n" + metaLines.join("\n")

    $done({
        title: nodeName,
        content: content,
        icon: "network",
        'title-color': "#007AFF"
    })
}

getIPs()
