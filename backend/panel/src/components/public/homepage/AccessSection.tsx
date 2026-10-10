/** Access anchor — generic sign-in plus product-specific registration entry points. */
export default function AccessSection() {
  return (
    <section className="ops-access" aria-labelledby="ops-access-heading">
      <div className="ops-access-inner">
        <h2 id="ops-access-heading" className="ops-access-title">
          Get access
        </h2>
        <p className="ops-access-lead">
          Sign in with one account for your eBay operations workspace.
        </p>
        <div className="ops-access-ctas">
          <a href="/login" className="ops-btn ops-btn--ghost">
            Sign In
          </a>
          <a href="/register?product=ebay" className="ops-btn ops-btn--primary">
            Start with eBay
          </a>
        </div>
      </div>
    </section>
  )
}
