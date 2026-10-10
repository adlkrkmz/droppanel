import type { ProcessStep } from '@/lib/infrastructure/process-stories'

type ProcessStepCardsProps = {
  steps: ProcessStep[]
}

export default function ProcessStepCards({ steps }: ProcessStepCardsProps) {
  return (
    <div className="ops-process-cards">
      {steps.map((step) => (
        <article key={step.id} className="ops-process-card">
          <h4 className="ops-process-card-label">{step.label}</h4>
          <p className="ops-process-card-desc">{step.description}</p>
          <p className="ops-process-card-status">{step.status}</p>
        </article>
      ))}
    </div>
  )
}
