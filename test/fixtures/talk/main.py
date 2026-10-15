"""A short talk used by the tests."""

from gaanim import Scene, Section, Transition, lecture, title_slide

scene = Scene(theme="presentation")
scene.assets.load_project()
S = scene.slides
S.target(4 * 60)

cover = scene.segment("Cover", template=title_slide, target=30)
title = scene.text("Sales 2026", role="title")
cover.bind(title=title)
scene.play([title.animate.write().duration(0.8)])
scene.stop("title")

# scene.segment("Commented out") is not a slide.
problem = scene.segment(
    "Problem",
    Transition.slide(0.5, "left"),
    template=lecture,
    target=60,
)
scene.wait(0.5); scene.stop("question")
scene.marker("answer")
scene.wait(0.5); scene.stop()

closing = scene.segment("Closing", notes="Thanks.", target=1.5 * 60)
with scene.voiceover("outro") as vo:
    scene.wait(1)
scene.stop('thanks')

scene.render()
