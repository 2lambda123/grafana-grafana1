package apiserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"

	"github.com/emicklei/go-restful/v3"
	apidiscoveryv2 "k8s.io/api/apidiscovery/v2"
	apidiscoveryv2beta1 "k8s.io/api/apidiscovery/v2beta1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apiserver/pkg/endpoints/discovery/aggregated"
	"k8s.io/apiserver/pkg/endpoints/handlers/negotiation"
	"k8s.io/apiserver/pkg/endpoints/handlers/responsewriters"
)

// apisProxyHandler serves the `/apis` endpoint.
type apisProxyHandler struct {
	delegate http.Handler
	codecs   serializer.CodecFactory
}

func newApisProxyHandler(delegate http.Handler) *apisProxyHandler {
	scheme := runtime.NewScheme()
	metav1.AddToGroupVersion(scheme, schema.GroupVersion{Version: "v1"})

	// TODO: keep the generic API server from wanting this
	unversioned := schema.GroupVersion{Group: "", Version: "v1"}
	scheme.AddUnversionedTypes(unversioned,
		&metav1.Status{},
		&metav1.APIVersions{},
		&metav1.APIGroupList{},
		&metav1.APIGroup{},
		&metav1.APIResourceList{},
	)
	utilruntime.Must(apidiscoveryv2.AddToScheme(scheme))
	utilruntime.Must(apidiscoveryv2beta1.AddToScheme(scheme))
	codecs := serializer.NewCodecFactory(scheme)
	return &apisProxyHandler{
		delegate: delegate,
		codecs:   codecs,
	}
}

func (a *apisProxyHandler) handle(req *restful.Request, resp *restful.Response, chain *restful.FilterChain) {
	if req.Request.URL.Path != "/apis" && req.Request.URL.Path != "/apis/" {
		chain.ProcessFilter(req, resp)
		return
	}
	apisHandlerWithAggregationSupport := aggregated.WrapAggregatedDiscoveryToHandler(a.v1handler(chain), a.v2handler(chain))
	apisHandlerWithAggregationSupport.ServeHTTP(resp.ResponseWriter, req.Request)
}

func (a *apisProxyHandler) v2handler(chain *restful.FilterChain) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		clonedReq := req.Clone(req.Context())
		newReq := restful.NewRequest(clonedReq)
		rw := httptest.NewRecorder()
		newRes := restful.NewResponse(rw)

		chain.ProcessFilter(newReq, newRes)
		if rw.Code != http.StatusOK {
			http.Error(w, rw.Body.String(), rw.Code)
			return
		}

		v2Discovery := apidiscoveryv2.APIGroupDiscoveryList{}
		if err := json.Unmarshal(rw.Body.Bytes(), &v2Discovery); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		clonedReq = req.Clone(req.Context())
		rw = httptest.NewRecorder()

		a.delegate.ServeHTTP(rw, clonedReq)
		if rw.Code != http.StatusOK {
			http.Error(w, rw.Body.String(), rw.Code)
			return
		}

		proxiedDiscovery := apidiscoveryv2.APIGroupDiscoveryList{}
		if err := json.Unmarshal(rw.Body.Bytes(), &proxiedDiscovery); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		v2Discovery.Items = append(v2Discovery.Items, proxiedDiscovery.Items...)
		responsewriters.WriteObjectNegotiated(a.codecs, aggregated.DiscoveryEndpointRestrictions, schema.GroupVersion{
			Group:   apidiscoveryv2.SchemeGroupVersion.Group,
			Version: apidiscoveryv2.SchemeGroupVersion.Version,
		}, w, req, http.StatusOK, &v2Discovery, true)
	}
}

func (a *apisProxyHandler) v1handler(chain *restful.FilterChain) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		clonedReq := req.Clone(req.Context())
		clonedReq.Header.Set("Accept", "application/json")
		newReq := restful.NewRequest(clonedReq)
		rw := httptest.NewRecorder()
		newRes := restful.NewResponse(rw)

		chain.ProcessFilter(newReq, newRes)
		if rw.Code != http.StatusOK {
			http.Error(w, rw.Body.String(), rw.Code)
			return
		}

		discoveryGroupList := metav1.APIGroupList{}
		if err := json.Unmarshal(rw.Body.Bytes(), &discoveryGroupList); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		clonedReq = req.Clone(req.Context())
		clonedReq.Header.Set("Accept", "application/json")
		rw = httptest.NewRecorder()

		a.delegate.ServeHTTP(rw, clonedReq)
		if rw.Code != http.StatusOK {
			http.Error(w, rw.Body.String(), rw.Code)
			return
		}

		proxiedGroups := metav1.APIGroupList{}
		if err := json.Unmarshal(rw.Body.Bytes(), &proxiedGroups); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		discoveryGroupList.Groups = append(discoveryGroupList.Groups, proxiedGroups.Groups...)
		responsewriters.WriteObjectNegotiated(a.codecs, negotiation.DefaultEndpointRestrictions, schema.GroupVersion{}, w, req, http.StatusOK, &discoveryGroupList, false)
	}
}
