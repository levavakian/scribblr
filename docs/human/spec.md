# Spec

The overall aim is to make a Chrome extension that reads the page you are on, translates some portion of it into the language you are learning, and allows you to see what the translated poriton originally was when hovering over the translated section.

## DevEx
- Top level, this project should have a shell.sh, when run it should use nix to drop the user into a shell that has all the requirements installed to build/run/test this project. It should also allow me to run a single command with that env via ./shell.sh -c <arbitrary commands here>
- This project should build a chrome extension.
- It should have a top level README describing exactly how to go from a fresh pull to having the chrome extension built and installed in chrome.

## Extension
- The extension should allow you to configure a source language and a target language
- It should take in a free tier Gemini API key
- It should have a slider for the percent of a page that should be translated
- It should have a slider for the distribution of chunk sizes (for example, single word all the way up to full paragraph)
- When an element becomes visible (paragraph, tweet, button, anything that could have text), it should be decided what distribution of chunks there will be (for example, for a long text it might be a paragraph, a few sentences, some single words, etc) and what portion of the text will be translated (if there's many options, we should land on what the slider is set at roughly, e.g. 40%, if it's a single word, then the same process should lead us to translating it roughly 40% of the time and not translating it 60% of the time, rather than translating just 40% of the word). Chunks should never break up words, links, or any other contiguous element.
- All the relevant text context of the page should be sent, with the sections to be translated annotated appropriately. For example, if all the text on the page is

```
<p1>
Cows are great. They have big friendly eyes, and they love to be around people.
</p1>

<button>
Learn more about cows?
</button>
```

then the model should receive something like (only representative, the actual structure or form can be whatever is optimal, this is only to show what context we want included and how to make sure the model can translate given that context, rather than in a vacuum)

```
<p1>
Cows are great. <chunk-0>They have big friendly eyes, and </chunk-0> they love to be around people.
</p1>

<button>
<chunk-1>Learn more</chunk-1> about cows?
</button>
```

Then it should request a structured output of a translation of each of the chunks 0..N to the target language
- When the translations are received, it should have a split-flap display like effect where the original text becoems the translated text. The translated text should have a dashed underdash to show that it was translated. Hovering over it should show the original text that was replaced.
- It should use the latest gemini flash model that is in the free tier
- If we hit a rate limit, it should pause the extension for an appropriate amount of time depending on if it's a daily limit or a minute-ly limit
- It should work on new text that streams in after the original text as well (for example, on something like chatgpt where it's a live chat)