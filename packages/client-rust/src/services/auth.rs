use std::fs;

use native_tls::TlsConnector;
use openssl::ssl::{SslAcceptor, SslMethod, SslVerifyMode};
use tokio_openssl::SslStream;
use tokio::net::TcpStream;

use crate::base::AppError;

/// Server 端：创建 SSL acceptor（验证客户端证书必须由指定 CA 签发）
pub fn create_tls_acceptor(
    server_p12_path: &str,
    ca_crt_path: &str,
) -> Result<SslAcceptor, AppError> {
    // 从 p12 提取证书和私钥
    let p12_data = fs::read(server_p12_path)?;
    let pkcs12 = openssl::pkcs12::Pkcs12::from_der(&p12_data)?
        .parse2("")?;

    let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls())?;

    if let Some(pkey) = pkcs12.pkey {
        builder.set_private_key(&pkey)?;
    }
    if let Some(cert) = pkcs12.cert {
        builder.set_certificate(&cert)?;
    }

    // 加载 CA 证书，用于验证客户端证书
    builder.set_ca_file(ca_crt_path)?;

    // 要求客户端提供证书，且必须验证通过
    builder.set_verify(SslVerifyMode::PEER | SslVerifyMode::FAIL_IF_NO_PEER_CERT);

    Ok(builder.build())
}

/// Server 端：执行 TLS 握手（含客户端证书验证）
pub async fn accept_tls(
    acceptor: &SslAcceptor,
    stream: TcpStream,
) -> Result<SslStream<TcpStream>, AppError> {
    let ssl = openssl::ssl::Ssl::new(acceptor.context())?;
    let mut tls_stream = SslStream::new(ssl, stream)?;
    std::pin::Pin::new(&mut tls_stream).accept().await?;
    Ok(tls_stream)
}

/// Client 端：创建 TLS connector（加载 Client 证书 + 信任自签 CA）
pub fn create_tls_connector(
    client_p12_path: &str,
    ca_crt_path: &str,
) -> Result<TlsConnector, AppError> {
    let p12_data = fs::read(client_p12_path)?;
    let identity = native_tls::Identity::from_pkcs12(&p12_data, "")?;

    let ca_pem = fs::read(ca_crt_path)?;
    let ca_cert = native_tls::Certificate::from_pem(&ca_pem)?;

    let connector = TlsConnector::builder()
        .identity(identity)
        .add_root_certificate(ca_cert)
        .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
        .build()?;

    Ok(connector)
}
