(function (exports) {
  const GENRES = [
    { id: 'classic-horror', name: 'Classic Horror', emoji: '&#128123;' },
    { id: 'superhero', name: 'Superhero Action', emoji: '&#129464;' },
    { id: 'dark-scifi', name: 'Dark Sci-Fi', emoji: '&#128125;' },
    { id: 'high-fantasy', name: 'High Fantasy', emoji: '&#128050;' },
    { id: 'neon-noir', name: 'Neon Noir', emoji: '&#128373;' },
    { id: 'wasteland', name: 'Wasteland', emoji: '&#9762;' },
    { id: 'comedy', name: 'Comedy', emoji: '&#128514;' },
    { id: 'teen-drama', name: 'Teen Drama', emoji: '&#127915;' },
    { id: 'custom', name: 'Custom', emoji: '&#9999;' },
  ];

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function getGenreEmoji(genre) {
    const g = GENRES.find(x => x.id === genre);
    return g ? g.emoji : '&#128214;';
  }

  exports.GENRES = GENRES;
  exports.escHtml = escHtml;
  exports.timeAgo = timeAgo;
  exports.getGenreEmoji = getGenreEmoji;
})(typeof module !== 'undefined' ? module.exports : this);
