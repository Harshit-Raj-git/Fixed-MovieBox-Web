
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode},
    routing::get,
    Json, Router,
};
use moviebox_tui::{
    providers::{
        models::{PlaybackSource, ProviderKind},
        ReleaseProvider,
    },
    service::MovieBoxService,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    provider: Option<String>,
    page: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ProviderQuery {
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SuggestQuery {
    q: String,
}

#[derive(Debug, Serialize)]
struct StreamOption {
    index: usize,
    filename: String,
    language: Option<String>,
    quality: Option<String>,
    codec: Option<String>,
    source_label: String,
    resolution: u64,
    has_headers: bool,
}

#[derive(Debug, Deserialize)]
struct PlayRequest {
    id: String,
    index: usize,
}

#[derive(Debug, Serialize)]
struct PlayResponse {
    url: String,
    headers: Vec<(String, String)>,
    source_label: String,
    max_height: Option<u64>,
    browser_compatible: bool,
    message: String,
}

fn parse_provider(
    value: Option<&str>,
) -> Result<ProviderKind, (StatusCode, String)> {
    match value {
        None | Some("") => Ok(ProviderKind::MovieBox),
        Some(value) => ProviderKind::parse(value).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("Unknown provider: {value}"),
            )
        }),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn suggest(
    State(service): State<MovieBoxService>,
    Query(params): Query<SuggestQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let query = params.q.trim();

    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }

    service
        .suggest(query)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

async fn search(
    State(service): State<MovieBoxService>,
    Query(params): Query<SearchQuery>,
) -> Result<
    Json<Vec<moviebox_tui::providers::models::CatalogItem>>,
    (StatusCode, String),
> {
    let query = params.q.trim();

    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let provider = parse_provider(params.provider.as_deref())?;
    let page = params.page.unwrap_or(1);

    service
        .search_typed(provider, query, page)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))
}

async fn title_details(
    State(service): State<MovieBoxService>,
    Path(id): Path<String>,
    Query(params): Query<ProviderQuery>,
) -> Result<
    Json<moviebox_tui::providers::models::MediaDetails>,
    (StatusCode, String),
> {
    let provider = parse_provider(params.provider.as_deref())?;

    service
        .details_typed(provider, &id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))
}

async fn movie_streams(
    State(service): State<MovieBoxService>,
    Path(id): Path<String>,
) -> Result<Json<Vec<StreamOption>>, (StatusCode, String)> {
    if id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Movie ID is required".into()));
    }

    let releases =
        ReleaseProvider::episode_streams(&service.client, &id, 0, 0)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let options = releases
        .iter()
        .enumerate()
        .filter_map(|(index, release)| {
            let mirror = release.mirrors.first()?;

            Some(StreamOption {
                index,
                filename: release.filename.clone(),
                language: release.language.clone(),
                quality: release.quality.clone(),
                codec: release.codec.clone(),
                source_label: mirror.label.clone(),
                resolution: release.resolution_u64(),
                has_headers: !mirror.headers.is_empty(),
            })
        })
        .collect();

    Ok(Json(options))
}

async fn play_movie(
    State(service): State<MovieBoxService>,
    Json(request): Json<PlayRequest>,
) -> Result<Json<PlayResponse>, (StatusCode, String)> {
    if request.id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Movie ID is required".into()));
    }

    let releases =
        ReleaseProvider::episode_streams(
            &service.client,
            &request.id,
            0,
            0,
        )
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let release = releases.get(request.index).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Selected stream not found. Refresh streams and retry.".into(),
        )
    })?;

    let mirror = release.mirrors.first().ok_or_else(|| {
        (StatusCode::BAD_GATEWAY, "No playable source".into())
    })?;

    let source = PlaybackSource {
        provider: release.provider,
        url: mirror.resolver_url.clone(),
        headers: mirror.headers.clone(),
        subtitle: None,
        source_label: mirror.label.clone(),
        max_height: Some(release.resolution_u64()),
    };

    let browser_compatible = source.headers.is_empty();

    Ok(Json(PlayResponse {
        url: source.url,
        headers: source.headers,
        source_label: source.source_label,
        max_height: source.max_height,
        browser_compatible,
        message: if browser_compatible {
            "No extra request headers were returned. Browser playback also depends on media format and CORS.".into()
        } else {
            "This source requires request headers. Use the backend proxy for browser playback.".into()
        },
    }))
}

async fn proxy_movie(
    State(service): State<MovieBoxService>,
    Path((id, index)): Path<(String, usize)>,
    incoming_headers: HeaderMap,
) -> Result<Response<Body>, (StatusCode, String)> {
    if id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Movie ID is required".into()));
    }

    let releases =
        ReleaseProvider::episode_streams(&service.client, &id, 0, 0)
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let release = releases.get(index).ok_or_else(|| {
        (StatusCode::NOT_FOUND, "Stream not found".into())
    })?;

    let mirror = release.mirrors.first().ok_or_else(|| {
        (StatusCode::BAD_GATEWAY, "No playable source".into())
    })?;

    let url = reqwest::Url::parse(&mirror.resolver_url)
        .map_err(|_| {
            (StatusCode::BAD_GATEWAY, "Invalid source URL".into())
        })?;

    if url.scheme() != "https" || url.host_str().is_none() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Only HTTPS source URLs are allowed".into(),
        ));
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    let mut upstream = client.get(url);

    for (name, value) in &mirror.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| {
                (StatusCode::BAD_GATEWAY, "Invalid source header".into())
            })?;

        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| {
                (StatusCode::BAD_GATEWAY, "Invalid source header value".into())
            })?;

        upstream = upstream.header(name, value);
    }

    if let Some(range) = incoming_headers.get(header::RANGE) {
        let range = range.to_str().map_err(|_| {
            (StatusCode::BAD_REQUEST, "Invalid Range header".into())
        })?;

        upstream = upstream.header(reqwest::header::RANGE, range);
    }

    let upstream_response = upstream
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = upstream_response.status();
    let upstream_headers = upstream_response.headers().clone();

    if status.is_redirection() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Source returned a redirect; its resolver must be handled first."
                .into(),
        ));
    }

    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Upstream video server returned HTTP {status}"),
        ));
    }

    let mut response = Response::builder().status(status);

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response = response.header(name, value);
        }
    }

    let body = Body::from_stream(upstream_response.bytes_stream());

    response.body(body).map_err(|e| {
        (StatusCode::BAD_GATEWAY, e.to_string())
    })
}


#[tokio::main]
async fn main() {
    let service = MovieBoxService::new();

    // Local development aur deployed Netlify frontend dono ko allow karo.
    let mut allowed_origins = vec![
        HeaderValue::from_static("http://localhost:5173"),
    ];

    if let Ok(frontend_url) = std::env::var("FRONTEND_URL") {
        match frontend_url.parse::<HeaderValue>() {
            Ok(origin) => allowed_origins.push(origin),
            Err(_) => {
                eprintln!("Invalid FRONTEND_URL environment variable");
                std::process::exit(1);
            }
        }
    }

    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::RANGE,
        ]);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/suggest", get(suggest))
        .route("/api/search", get(search))
        .route("/api/title/{id}", get(title_details))
        .route("/api/streams/{id}", get(movie_streams))
        .route("/api/play", axum::routing::post(play_movie))
        .route("/api/proxy/{id}/{index}", get(proxy_movie))
        .with_state(service)
        .layer(cors);

    // Render provides PORT automatically.
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .expect("Invalid PORT environment variable");

    let address = SocketAddr::from(([0, 0, 0, 0], port));

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind backend port");

    println!("MovieBox Web API listening on {address}");

    axum::serve(listener, app)
        .await
        .expect("backend server failed");
}
