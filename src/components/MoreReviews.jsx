import React, { useState } from "react";

export default function Reviews() {
  const [selectedImage, setSelectedImage] = useState(null);

  return (
    <section className="px-4 mt-20 py-12 max-w-7xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-bold mb-12 text-center text-white">
        Community Reviews
      </h1>

      <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
        <img
          src="/All_reviews/steal.png"
          alt="Review steal"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/steal.png")}
        />
        <img
          src="/All_reviews/aum.png"
          alt="Review aum"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/aum.png")}
        />
        <img
          src="/All_reviews/frost.png"
          alt="Review frost"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/frost.png")}
        />
        <img
          src="/All_reviews/fuga.png"
          alt="Review fuga"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/fuga.png")}
        />
        <img
          src="/All_reviews/matthew.png"
          alt="Review matthew"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/matthew.png")}
        />
        <img
          src="/All_reviews/junnsot.png"
          alt="Review junnsot"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/junnsot.png")}
        />
        <img
          src="/All_reviews/jx.png"
          alt="Review jx"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/jx.png")}
        />
        <img
          src="/All_reviews/jayy.png"
          alt="Review jayy"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/jayy.png")}
        />
        <img
          src="/All_reviews/neuro.png"
          alt="Review neuro"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/neuro.png")}
        />

        <img
          src="/All_reviews/coerbii.png"
          alt="Review coerbii"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/coerbii.png")}
        />
        <img
          src="/All_reviews/cyerx.png"
          alt="Review cyerx"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/cyerx.png")}
        />
        <img
          src="/All_reviews/frost2.png"
          alt="Review frost2"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/frost2.png")}
        />
        <img
          src="/All_reviews/honf_mod.png"
          alt="Review honf"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/honf_mod.png")}
        />
        <img
          src="/All_reviews/jack.png"
          alt="Review jack"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/jack.png")}
        />
        <img
          src="/All_reviews/jay4a1.png"
          alt="Review jay4a1"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/jay4a1.png")}
        />
        <img
          src="/All_reviews/muzexx.png"
          alt="Review muzexx"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/muzexx.png")}
        />
        <img
          src="/All_reviews/stefan.png"
          alt="Review stefan"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/stefan.png")}
        />
        <img
          src="/All_reviews/turkey.png"
          alt="Review turkey"
          className="w-full mb-4 cursor-pointer rounded-xl shadow-lg break-inside"
          onClick={() => setSelectedImage("/All_reviews/turkey.png")}
        />
      </div>

      {/* Modal */}
      {selectedImage && (
        <div
          className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedImage(null)}
        >
          <img
            src={selectedImage}
            alt="Selected review"
            className="max-w-full max-h-full rounded-lg"
          />
        </div>
      )}
    </section>
  );
}
