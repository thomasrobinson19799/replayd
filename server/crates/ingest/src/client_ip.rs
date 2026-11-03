//! Client IP for rate limiting: the TCP peer, or — when the peer is a trusted proxy (site nginx tunnel,
//! our own nginx) — the right-most untrusted `X-Forwarded-For` entry. The IP is never stored (§8).

use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

pub fn client_ip(peer: SocketAddr, headers: &HeaderMap, trusted: &[IpAddr]) -> IpAddr {
    let peer_ip = canonical(peer.ip());
    if !trusted.contains(&peer_ip) {
        return peer_ip;
    }
    let mut last = peer_ip;
    for v in headers.get_all("x-forwarded-for").iter().rev() {
        let Ok(s) = v.to_str() else { continue };
        for part in s.rsplit(',') {
            match part.trim().parse::<IpAddr>() {
                Ok(ip) => {
                    let ip = canonical(ip);
                    if !trusted.contains(&ip) {
                        return ip;
                    }
                    last = ip;
                }
                Err(_) => return last,
            }
        }
    }
    last
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn xff_only_from_trusted_peers() {
        let trusted: Vec<IpAddr> = vec!["10.0.0.1".parse().unwrap(), "10.0.0.2".parse().unwrap()];
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.1.1.1, 9.9.9.9, 10.0.0.2"),
        );
        let untrusted_peer: SocketAddr = "5.5.5.5:1234".parse().unwrap();
        assert_eq!(
            client_ip(untrusted_peer, &h, &trusted),
            "5.5.5.5".parse::<IpAddr>().unwrap()
        );
        let proxy: SocketAddr = "10.0.0.1:1234".parse().unwrap();
        assert_eq!(
            client_ip(proxy, &h, &trusted),
            "9.9.9.9".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            client_ip(proxy, &HeaderMap::new(), &trusted),
            "10.0.0.1".parse::<IpAddr>().unwrap()
        );
        let mapped: SocketAddr = "[::ffff:10.0.0.1]:1".parse().unwrap();
        assert_eq!(
            client_ip(mapped, &h, &trusted),
            "9.9.9.9".parse::<IpAddr>().unwrap()
        );
    }
}
