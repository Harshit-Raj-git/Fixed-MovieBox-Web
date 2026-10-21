import { useState } from "react";
import {
  Search,
  Film,
  X,
  ArrowLeft,
  LoaderCircle,
  Play,
} from "lucide-react";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:3000/api";

const providers = [
  { value: "moviebox", label: "MovieBox" },
  { value: "fourkhdhub", label: "4KHDHub" },
  { value: "dramachi", label: "DramaChi" },
  { value: "bdix_circleftp", label: "CircleFTP" },
  { value: "bdix_dhakaflix", label: "DhakaFlix" },
];



function getStreamLanguage(stream) {
  const explicit = stream.language?.trim();

  if (explicit && explicit.toLowerCase() !== "unknown") {
    return explicit;
  }

  const text = [
    stream.filename,
    stream.source_label,
    stream.label,
    stream.name,
    stream.audio,
    stream.codec,
  ]
    .filter(Boolean)
    .join(" ");

  const languages = [
    "Hindi",
    "English",
    "Tamil",
    "Telugu",
    "Malayalam",
    "Kannada",
    "Bengali",
    "Punjabi",
    "Japanese",
    "Korean",
    "Chinese",
    "Spanish",
    "French",
    "Arabic",
    "Urdu",
  ];

  // Prefer a language explicitly written in the stream name.
  const bracketMatch = text.match(/\[([^\]]+)\]/);

  if (bracketMatch) {
    const candidate = bracketMatch[1].trim();
    const match = languages.find(
      (language) =>
        language.toLowerCase() === candidate.toLowerCase()
    );

    if (match) return match;
  }

  // Otherwise detect a language mentioned in the metadata.
  const match = languages.find((language) =>
    new RegExp(`\\b${language}\\b`, "i").test(text)
  );

  return match || "Unknown";
}



function getStreamQuality(stream) {
  return (
    stream.quality ||
    stream.filename ||
    `Stream ${(stream.index ?? 0) + 1}`
  );
}

export default function App() {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("moviebox");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);

  const [loading, setLoading] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  const [streams, setStreams] = useState([]);
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [selectedQuality, setSelectedQuality] = useState("");
  const [playing, setPlaying] = useState(false);

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Backend se valid JSON response nahi mila.");
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
          data?.message ||
          `Request failed (${response.status}).`
      );
    }

    return data;
  }

  async function searchMovies(event) {
    event?.preventDefault();

    const q = query.trim();

    if (!q) {
      setError("Movie ya series ka naam likho.");
      return;
    }

    setLoading(true);
    setError("");
    setSelected(null);
    setStreams([]);
    setPlaying(false);
    setSearched(true);

    try {
      const params = new URLSearchParams({
        q,
        provider,
        page: "1",
      });

      const data = await requestJson(
        `${API}/search?${params.toString()}`
      );

      if (!Array.isArray(data)) {
        throw new Error("Search API ka response expected format mein nahi hai.");
      }

      setResults(data);

      if (data.length === 0) {
        setError("Koi result nahi mila. Dusra naam try karo.");
      }
    } catch (err) {
      setResults([]);
      setError(
        err.message === "Failed to fetch"
          ? "Backend connect nahi ho raha. Check karo ki Rust API port 3000 par chal rahi hai."
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadStreams(title) {
    setStreamLoading(true);
    setStreams([]);
    setSelectedLanguage("");
    setSelectedQuality("");
    setPlaying(false);

    try {
      const idValue = title?.id?.value;

      if (!idValue) {
        throw new Error("Title ID nahi mila; stream request nahi bhej sakte.");
      }

      const params = new URLSearchParams({
        provider: title.id.provider || provider,
      });

      const id = encodeURIComponent(idValue);

      const data = await requestJson(
        `${API}/streams/${id}?${params.toString()}`
      );

      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.value)
          ? data.value
          : [];

      if (list.length === 0) {
        setError("Is title ke liye koi stream available nahi hai.");
        return;
      }

      setStreams(list);

      const languages = [
        ...new Set(list.map(getStreamLanguage)),
      ];

      const firstLanguage = languages[0] || "Unknown";
      const firstStream = list.find(
        (stream) => getStreamLanguage(stream) === firstLanguage
      );

      setSelectedLanguage(firstLanguage);
      setSelectedQuality(
        firstStream?.index == null
          ? ""
          : String(firstStream.index)
      );
    } catch (err) {
      setError(`Streams load nahi hue: ${err.message}`);
    } finally {
      setStreamLoading(false);
    }
  }

  async function openDetails(item) {
    setLoading(true);
    setError("");
    setSelected(null);
    setStreams([]);
    setPlaying(false);

    try {
      const idValue = item?.id?.value;

      if (!idValue) {
        throw new Error("Search result mein title ID nahi mila.");
      }

      const params = new URLSearchParams({
        provider: item.id.provider || provider,
      });

      const id = encodeURIComponent(idValue);

      const data = await requestJson(
        `${API}/title/${id}?${params.toString()}`
      );

      setSelected(data);

      // Details response mein ID absent ho toh search result ka ID preserve karo.
      const titleForStreams = {
        ...data,
        id: data?.id?.value
          ? data.id
          : item.id,
      };

      // Stream loading ko selected title ke ID ke saath start karo.
      await loadStreams(titleForStreams);
    } catch (err) {
      setError(`Details: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function changeLanguage(language) {
    setSelectedLanguage(language);
    setPlaying(false);

    const firstMatchingStream = streams.find(
      (stream) => getStreamLanguage(stream) === language
    );

    setSelectedQuality(
      firstMatchingStream?.index == null
        ? ""
        : String(firstMatchingStream.index)
    );
  }

  function playSelected() {
    if (!selected || selectedQuality === "") {
      setError("Pehle available quality select karo.");
      return;
    }

    setError("");
    setPlaying(true);
  }

  function goBack() {
    setSelected(null);
    setStreams([]);
    setPlaying(false);
    setError("");
  }

  const availableLanguages = [
    ...new Set(streams.map(getStreamLanguage)),
  ];

  const availableQualities = streams.filter(
    (stream) =>
      getStreamLanguage(stream) === selectedLanguage
  );

  const selectedStream = streams.find(
    (stream) => String(stream.index) === selectedQuality
  );

  const selectedId = selected?.id?.value;

  const videoUrl =
    selectedId && selectedQuality !== ""
      ? `${API}/proxy/${encodeURIComponent(selectedId)}/${encodeURIComponent(selectedQuality)}`
      : "";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => {
            goBack();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="MovieBox Web home"
        >
          <span className="brand-icon">
            <Film size={23} />
          </span>
          <span>
            MovieBox<span className="brand-accent"> Web</span>
          </span>
        </button>

        <span className="local-tag">LOCAL APP</span>
      </header>

      <section className="hero">
        <p className="eyebrow">YOUR MOVIE LIBRARY</p>

        <h1>
          What do you want to <span>watch?</span>
        </h1>

        <p className="hero-subtitle">
          Search movies and series from your selected provider.
        </p>

        <form className="search-form" onSubmit={searchMovies}>
          <Search size={21} className="search-icon" />

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Movie ya series search karo..."
            aria-label="Search movies and series"
          />

          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label="Select provider"
          >
            {providers.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <button type="submit" disabled={loading}>
            {loading ? (
              <LoaderCircle className="spin" size={19} />
            ) : (
              "Search"
            )}
          </button>
        </form>
      </section>

      {error && (
        <div className="message" role="alert">
          <span>{error}</span>

          <button
            type="button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <X size={18} />
          </button>
        </div>
      )}

      {selected ? (
        <section className="details-panel">
          <button
            className="back-button"
            type="button"
            onClick={goBack}
          >
            <ArrowLeft size={17} />
            Back to results
          </button>

          <div className="details-content">
            {selected.poster_url ? (
              <img
                className="details-poster"
                src={selected.poster_url}
                alt={`${selected.title || "Movie"} poster`}
              />
            ) : (
              <div className="details-poster poster-placeholder">
                <Film size={42} />
              </div>
            )}

            <div className="details-copy">
              <p className="eyebrow">
                {selected.media_type || "TITLE"}
              </p>

              <h2>{selected.title}</h2>

              <p className="muted">
                {[
                  selected.year,
                  selected.duration,
                  selected.imdb_rating &&
                    `IMDb ${selected.imdb_rating}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>

              {selected.genres?.length > 0 && (
                <p className="genre-list">
                  {selected.genres.join(" · ")}
                </p>
              )}

              <p className="description">
                {selected.description ||
                  "Is title ke liye description available nahi hai."}
              </p>

              {selected.director && (
                <p>
                  <strong>Director:</strong> {selected.director}
                </p>
              )}

              {selected.stars && (
                <p>
                  <strong>Cast:</strong> {selected.stars}
                </p>
              )}

              <section className="playback-panel">
                <h3>Watch</h3>

                {streamLoading ? (
                  <p className="muted">
                    <LoaderCircle className="spin inline-spinner" size={16} />
                    Available streams load ho rahe hain...
                  </p>
                ) : streams.length > 0 ? (
                  <>
                    <label htmlFor="language-select">
                      Language
                    </label>

                    <select
                      id="language-select"
                      value={selectedLanguage}
                      onChange={(event) =>
                        changeLanguage(event.target.value)
                      }
                    >
                      {availableLanguages.map((language) => (
                        <option key={language} value={language}>
                          {language}
                        </option>
                      ))}
                    </select>

                    <label htmlFor="quality-select">
                      Quality
                    </label>

                    <select
                      id="quality-select"
                      value={selectedQuality}
                      onChange={(event) => {
                        setSelectedQuality(event.target.value);
                        setPlaying(false);
                      }}
                    >
                      {availableQualities.map((stream) => (
                        <option
                          key={stream.index}
                          value={String(stream.index)}
                        >
                          {getStreamQuality(stream)}
                        </option>
                      ))}
                    </select>

                    {selectedStream?.codec && (
                      <p className="muted stream-meta">
                        Codec: {selectedStream.codec}
                      </p>
                    )}

                    <button
                      className="play-button"
                      type="button"
                      onClick={playSelected}
                      disabled={!selectedStream}
                    >
                      <Play size={18} fill="currentColor" />
                      Play
                    </button>

                    {playing && videoUrl && (
                      <div className="player-container">
                        <video
                          key={videoUrl}
                          className="video-player"
                          controls
                          autoPlay
                          playsInline
                          preload="metadata"
                          src={videoUrl}
                          onError={() => {
                            setError(
                              "Video play nahi hua. Backend proxy logs check karo; source redirect, expired URL ya unsupported format ho sakta hai."
                            );
                          }}
                        >
                          Your browser does not support video playback.
                        </video>

                        <p className="muted player-note">
                          Agar video start nahi hota, backend proxy ko
                          source ke redirects aur headers handle karne
                          pad sakte hain.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="muted">
                    Is title ke liye stream options nahi mile.
                  </p>
                )}
              </section>

              {selected.seasons?.length > 0 && (
                <div className="seasons">
                  <h3>Seasons &amp; Episodes</h3>

                  {selected.seasons.map((season) => (
                    <div
                      className="season"
                      key={season.number}
                    >
                      <h4>Season {season.number}</h4>

                      {(season.episodes || []).map((episode) => (
                        <div
                          className="episode"
                          key={`${episode.season}-${episode.number}`}
                        >
                          <div>
                            <strong>
                              Episode {episode.number}
                              {episode.title
                                ? ` — ${episode.title}`
                                : ""}
                            </strong>

                            {episode.overview && (
                              <p className="muted">
                                {episode.overview}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="results-section">
          <div className="section-heading">
            <h2>
              {searched
                ? "Search results"
                : "Find your next watch"}
            </h2>

            {results.length > 0 && (
              <span className="result-count">
                {results.length} results
              </span>
            )}
          </div>

          {loading && (
            <div className="loading-state">
              <LoaderCircle className="spin" size={25} />
              <span>Loading...</span>
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="movie-grid">
              {results.map((item) => (
                <button
                  className="movie-card"
                  type="button"
                  key={`${item.id.provider}-${item.id.value}`}
                  onClick={() => openDetails(item)}
                >
                  <div className="poster-wrap">
                    {item.poster_url ? (
                      <img
                        src={item.poster_url}
                        alt={item.title}
                        loading="lazy"
                      />
                    ) : (
                      <div className="poster-placeholder">
                        <Film size={36} />
                      </div>
                    )}

                    <span className="type-tag">
                      {item.media_type || "Title"}
                    </span>
                  </div>

                  <div className="movie-info">
                    <h3>{item.title}</h3>
                    <p>{item.year || "Year unavailable"}</p>

                    {item.season_count > 0 && (
                      <p>{item.season_count} seasons</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loading && !searched && (
            <div className="empty-state">
              <Film size={36} />
              <p>
                Search for a movie or series to get started.
              </p>
            </div>
          )}
        </section>
      )}

      <footer>
        MovieBox Web · Local development · Not affiliated with providers
      </footer>
    </main>
  );
}