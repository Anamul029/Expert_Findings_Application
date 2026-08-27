# Searching Plan

## 1. Overview

The search system should support three primary user journeys:

1. **Known expert search** — the user already knows whom they are looking for.
2. **Expert discovery through filters** — the user knows what type of expert they need but does not know a specific person.
3. **AI-powered problem search** *(future)* — the user describes their problem, and AI recommends the appropriate expert category.

The search experience should be designed so that users can start with a simple search and progressively narrow down the results when necessary.

---

## 2. Search Journey 1 — Search for a Known Expert

### User Intent

The user already knows the name of the expert they want to find.

### Example

> "I want to find Dr. Luna."

The user goes directly to the search bar and searches for:

```text
Dr. Luna
```

### Search Result

The system should return matching experts and relevant information such as:

* Expert name
* Expert profile photo
* Expertise/category
* Sub-category
* Organization
* Location
* Availability/status
* Rating
* Number of reviews
* Verification status

### Search Behavior

The search should support:

* Exact name matching
* Partial name matching
* Fuzzy/typo-tolerant matching
* Name + profession matching
* Name + organization matching
* Name + location matching

### Example Queries

```text
Dr. Luna
Luna
Dr. Luna Dhaka
Dr. Luna Brainstation
Luna doctor
```

The primary goal is to help the user find the specific person as quickly as possible without requiring them to go through multiple filters.

---

# 3. Search Journey 2 — Find the Best Expert by Category

## User Intent

The user does not know which specific expert they want.

However, they know the **type of expert** they need.

### Example

> "I need a developer."

Instead of searching for a person's name, the user starts by selecting an expert category.

---

## 3.1 Category Selection

The first level of filtering is the **Category**.

Example:

```text
IT
Healthcare
Legal
Finance
Education
Business
Design
Marketing
```

For the example:

```text
IT
```

is selected.

---

## 3.2 Sub-category Selection

After selecting the main category, the user selects a more specific area of expertise.

For `IT`:

```text
Frontend Developer
Backend Developer
Full-Stack Developer
DevOps Engineer
Data Engineer
Mobile Developer
QA Engineer
Cybersecurity Expert
```

Example:

```text
IT
  └── Backend Developer
```

---

## 3.3 Sub-sub-category Selection

The user can further narrow down the specialization.

For example, after selecting:

```text
Backend Developer
```

the system may provide:

```text
JavaScript / Node.js
Python
Java
PHP
Go
Ruby
C#
```

Example:

```text
IT
  └── Backend Developer
       └── Python
```

The number of category levels should not necessarily be fixed. The taxonomy should support additional levels when a profession requires deeper specialization.

---

# 4. Additional Search Filters

After selecting the expert category and specialization, users can refine the result using optional filters.

The user should **not be required to use every filter**.

---

## 4.1 Location

Allow users to find experts based on location.

Examples:

```text
Dhaka
Chittagong
Sylhet
Bangladesh
Remote
Online
```

Possible location filtering:

* Country
* State/division
* City
* Area
* Radius/distance
* Online/remote availability

Example:

```text
Location: Dhaka
```

---

## 4.2 Price Range

Users can filter experts according to their budget.

Example:

```text
Minimum: ৳500
Maximum: ৳2,000
```

The implementation should support the relevant pricing model for each expert category.

For example:

* Per consultation
* Per hour
* Per session
* Per project

---

## 4.3 Review Count

Users may want experts who have sufficient previous user feedback.

Example:

```text
Minimum reviews: 50
```

Possible filter:

```text
Reviews
[ 50+ ]
```

This can help users distinguish between highly reviewed experts and experts with very little history.

---

## 4.4 Rating Range

Users can filter experts by rating.

Example:

```text
4.0 - 5.0
```

Possible options:

```text
4.0+
4.5+
4.8+
```

The rating should be calculated from the platform's review system.

---

## 4.5 Verification Status

Users may want to see only verified experts.

Example:

```text
Verified only: Yes
```

Possible values:

```text
All
Verified
Unverified
```

The UI should clearly communicate what "Verified" means.

---

## 4.6 Organization

Users may search for experts associated with a particular organization.

Example:

```text
Organization: Brainstation
```

Possible use cases:

```text
Brainstation
Google
Microsoft
University XYZ
Hospital ABC
```

Organization filtering should work independently or together with other filters.

---

## 4.7 Qualification

Users can filter experts based on their educational or professional qualifications.

Examples:

```text
BSc
MSc
PhD
MBBS
MD
MBA
BBA
```

Example:

```text
Qualification:
☑ BSc
☑ MSc
```

The qualification system should ideally support standardized qualification data rather than relying entirely on free-text values.

---

## 4.8 Language

Users may want an expert who communicates in a particular language.

Examples:

```text
Bangla
English
Arabic
Hindi
```

Multiple languages should be selectable.

Example:

```text
Languages:
☑ Bangla
☑ English
```

---

## 4.9 Status

Users can filter experts based on whether they are currently active/available.

Example:

```text
Status:
Active
Inactive
```

Depending on the product requirements, this may later become more detailed:

```text
Available now
Available today
Available this week
Offline
Inactive
```

---

# 5. Example Discovery Flow

A complete example could look like this:

```text
User needs a developer
        ↓
Category
        ↓
IT
        ↓
Sub-category
        ↓
Backend Developer
        ↓
Sub-sub-category
        ↓
Python
        ↓
Location
        ↓
Dhaka
        ↓
Price
        ↓
৳500 - ৳2,000
        ↓
Rating
        ↓
4.5+
        ↓
Reviews
        ↓
50+
        ↓
Verified
        ↓
Yes
        ↓
Language
        ↓
Bangla + English
        ↓
Status
        ↓
Active
        ↓
Search Results
```

All filters should be optional after the initial category selection.

---

# 6. Search Result Ranking

Filtering determines **who qualifies** for the result set.

Ranking determines **who appears first**.

The initial ranking system can consider:

1. Relevance to the search query
2. Category/sub-category match
3. Location match
4. Availability/status
5. Rating
6. Review count
7. Verification
8. Profile completeness
9. Price
10. Other platform-specific quality signals

A basic ranking strategy could be:

```text
Search relevance
        +
Category relevance
        +
Location relevance
        +
Rating/review quality
        +
Availability
```

The ranking algorithm should avoid simply putting the highest-rated expert first. An expert with a 5.0 rating from two reviews should not automatically outrank an expert with a 4.9 rating from 500 reviews.

---

# 7. Search Bar Behavior

The search bar should support both **direct search** and **discovery**.

### Direct Search

```text
Dr. Luna
```

The system understands that the user may be looking for a specific expert.

### Category Search

```text
Python developer
```

The system can interpret this as a category/specialization search.

### Organization Search

```text
Brainstation
```

The system can return experts associated with that organization.

### Location-Based Search

```text
Python developer in Dhaka
```

The system can extract:

```text
Category: Backend Developer
Technology: Python
Location: Dhaka
```

This means the search bar can eventually become more intelligent without forcing users to manually select every filter.

---

# 8. Search Query Structure

Internally, a search request can be represented conceptually as:

```text
Search Query
├── Free-text query
├── Category
├── Sub-category
├── Sub-sub-category
├── Location
├── Price range
├── Minimum review count
├── Rating range
├── Verification status
├── Organization
├── Qualification
├── Language
└── Status
```

Example:

```json
{
  "query": "Python developer",
  "category": "IT",
  "subCategory": "Backend Developer",
  "specialization": "Python",
  "location": "Dhaka",
  "priceRange": {
    "min": 500,
    "max": 2000
  },
  "minimumReviews": 50,
  "rating": {
    "min": 4.5
  },
  "verified": true,
  "organization": "Brainstation",
  "qualifications": ["BSc", "MSc"],
  "languages": ["Bangla", "English"],
  "status": "active"
}
```

The actual API/data model can evolve independently from the UI.

---

# 9. Search UX Principles

## Progressive Filtering

Do not show every possible filter immediately.

Start with:

```text
Search
Category
Location
```

Then expose advanced filters when needed.

Possible UI structure:

```text
Search Experts

[ Search by name, expertise, organization... ]

Category
[ IT ▼ ]

Specialization
[ Backend Developer ▼ ]

Location
[ Dhaka ▼ ]

[ More Filters ]

    Price
    Rating
    Reviews
    Verified
    Organization
    Qualification
    Language
    Status

[ Search ]
```

---

## Filter Persistence

When users apply filters, the selected filters should remain visible.

Example:

```text
IT ×
Backend Developer ×
Python ×
Dhaka ×
4.5+ ×
Verified ×
```

Users should be able to remove individual filters without restarting the search.

---

## Empty Results

If no expert matches the selected filters, the system should explain why and suggest relaxing filters.

Example:

> No verified Python backend developers in Dhaka with a rating of 4.5+ and 50+ reviews were found.

Suggestions:

```text
Try removing "Verified"
Try lowering the rating to 4.0+
Try increasing the price range
Try expanding the location
```

---

# 10. Search Journey 3 — AI Problem-Based Search

**Status: Future Feature**

In this journey, the user does not know:

* Which expert they need
* Which category to select
* Which specialization is appropriate

Instead, they describe their problem in natural language.

### Example

User enters:

> "I've been having frequent headaches for the last few days. Which type of doctor should I see?"

The AI analyzes the query and recommends an appropriate expert category.

Example:

```text
User Problem
     ↓
AI Analysis
     ↓
Recommended Expert Type
     ↓
Doctor → Relevant Medical Specialty
     ↓
Expert Search
```

The AI should then transfer the user into the existing expert-search flow.

For example:

```text
AI Recommendation:

You may want to consult a neurologist.

[Find Neurologists]
```

After clicking:

```text
Category
→ Healthcare

Sub-category
→ Neurology

Location
→ Optional

Price
→ Optional

Rating
→ Optional

...
```

This means the future AI search should **not replace the existing search system**. It should act as an intelligent entry point into it.

---

# 11. Three Search Entry Points

The final product should support three clear entry points:

```text
                    EXPERT SEARCH
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
     Know the         Know the       Don't know
      person          category       the expert
          │              │              │
          ▼              ▼              ▼
      Name Search     Filter Search   AI Search
          │              │              │
          ▼              ▼              ▼
     Dr. Luna        IT → Backend    Describe Problem
                         → Python          │
                              │             ▼
                              └──────→ AI Recommendation
                                             │
                                             ▼
                                      Expert Category
                                             │
                                             ▼
                                       Filter Search
```

---

# 12. MVP vs Future Scope

## MVP

The first version should prioritize deterministic search and filtering.

### Must Have

* [ ] Search by expert name
* [ ] Search by keyword/expertise
* [ ] Category selection
* [ ] Sub-category selection
* [ ] Sub-sub-category selection
* [ ] Location filter
* [ ] Price range
* [ ] Rating filter
* [ ] Review count filter
* [ ] Verified filter
* [ ] Organization filter
* [ ] Qualification filter
* [ ] Language filter
* [ ] Active/status filter
* [ ] Combined filters
* [ ] Search result ranking
* [ ] Empty-result handling
* [ ] Filter removal/reset

## Future

* [ ] AI problem-based search
* [ ] Natural-language query understanding
* [ ] AI-generated category recommendations
* [ ] Query-to-filter extraction
* [ ] Personalized ranking
* [ ] Semantic/expertise search
* [ ] Search history
* [ ] Personalized recommendations
* [ ] Conversational expert discovery

---

# 13. Recommended Implementation Strategy

The search architecture should separate **search intent**, **filtering**, and **ranking**.

```text
User Input
    ↓
Query Understanding
    ↓
Intent Detection
    ├── Known Expert
    ├── Category Discovery
    └── AI Problem Search (Future)
    ↓
Filter Extraction
    ↓
Search Engine
    ↓
Filtering
    ↓
Ranking
    ↓
Expert Results
```

For the MVP, query understanding can remain relatively simple.

For example:

```text
"Dr. Luna"
    → Expert-name search

"Python developer"
    → Category/specialization search

"Python developer in Dhaka"
    → Category + specialization + location

"Brainstation Python developers"
    → Organization + specialization
```

Later, an AI/NLP layer can make this significantly more flexible.

---

# 14. Final Product Goal

The search system should answer three fundamental user questions:

### "I know who I want."

```text
Search → Dr. Luna → Profile
```

### "I know what I need."

```text
Category → Sub-category → Filters → Best Experts
```

### "I don't know what I need."

```text
Describe Problem → AI Recommendation → Category → Filters → Best Experts
```

The core principle is:

> **Users should be able to start with as little information as they have and progressively discover the right expert without being forced through unnecessary steps.**
